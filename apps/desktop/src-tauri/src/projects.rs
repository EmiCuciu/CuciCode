use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::paths::{claude_config_dir, encode_project_path};
use crate::settings::cucicode::{load_document, save_document, user_settings_path};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub branch: Option<String>,
    pub dirty: bool,
    pub remote_host: Option<String>,
    pub last_activity: Option<u64>,
}

#[derive(Debug, Default, PartialEq)]
pub struct GitStatus {
    pub branch: Option<String>,
    pub dirty: bool,
}

fn git(project_path: &Path, args: &[&str]) -> Option<String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(project_path).args(args).stdin(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

pub fn parse_status(porcelain: &str) -> GitStatus {
    let mut status = GitStatus::default();
    for line in porcelain.lines() {
        if let Some(head) = line.strip_prefix("# branch.head ") {
            status.branch = Some(head.trim().to_owned());
        } else if !line.starts_with('#') && !line.trim().is_empty() {
            status.dirty = true;
        }
    }
    status
}

pub fn remote_host(url: &str) -> Option<String> {
    let url = url.trim();
    if !url.contains("://") && !url.contains('@') {
        return None;
    }
    let rest = match url.split_once("://") {
        Some((_, rest)) => rest,
        None => url,
    };
    let rest = rest.rsplit_once('@').map_or(rest, |(_, host)| host);
    let host = rest.split(['/', ':']).next().unwrap_or_default();
    (!host.is_empty() && host.contains('.')).then(|| host.to_owned())
}

fn last_activity(project_path: &Path) -> Option<u64> {
    let transcripts = claude_config_dir().ok()?.join("projects").join(encode_project_path(project_path));
    fs::read_dir(transcripts)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|extension| extension == "jsonl"))
        .filter_map(|entry| entry.metadata().ok()?.modified().ok())
        .filter_map(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .max()
}

pub fn describe(project_path: &Path) -> Project {
    let status = git(project_path, &["status", "--porcelain=v2", "--branch"])
        .map(|output| parse_status(&output))
        .unwrap_or_default();
    let remote = git(project_path, &["remote", "get-url", "origin"]).and_then(|url| remote_host(&url));
    Project {
        id: encode_project_path(project_path),
        name: project_path
            .file_name()
            .map_or_else(|| project_path.display().to_string(), |name| name.to_string_lossy().into_owned()),
        path: project_path.display().to_string(),
        branch: status.branch,
        dirty: status.dirty,
        remote_host: remote,
        last_activity: last_activity(project_path),
    }
}

fn registered_paths() -> AppResult<Vec<PathBuf>> {
    let document = load_document(&user_settings_path()?)?;
    Ok(document
        .get("projects")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(PathBuf::from).collect())
        .unwrap_or_default())
}

fn save_paths(paths: &[PathBuf]) -> AppResult<()> {
    let path = user_settings_path()?;
    let mut document = load_document(&path)?;
    let list: Vec<String> = paths.iter().map(|item| item.display().to_string()).collect();
    document.insert("projects".into(), json!(list));
    save_document(&path, document)
}

pub fn list() -> AppResult<Vec<Project>> {
    Ok(registered_paths()?.iter().filter(|path| path.is_dir()).map(|path| describe(path)).collect())
}

pub fn add(path: &Path) -> AppResult<Project> {
    if !path.is_dir() {
        return Err(AppError::Invalid(format!("{} is not a folder", path.display())));
    }
    let mut paths = registered_paths()?;
    if !paths.iter().any(|existing| encode_project_path(existing) == encode_project_path(path)) {
        paths.push(path.to_path_buf());
        save_paths(&paths)?;
    }
    Ok(describe(path))
}

pub fn remove(id: &str) -> AppResult<()> {
    let paths: Vec<PathBuf> = registered_paths()?.into_iter().filter(|path| encode_project_path(path) != id).collect();
    save_paths(&paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_and_clean_state() {
        let status = parse_status("# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n");
        assert_eq!(status, GitStatus { branch: Some("main".into()), dirty: false });
    }

    #[test]
    fn any_changed_or_untracked_entry_means_dirty() {
        assert!(parse_status("# branch.head feature/x\n1 .M N... 100644 100644 100644 a b src/lib.rs\n").dirty);
        assert!(parse_status("# branch.head main\n? notes.txt\n").dirty);
    }

    #[test]
    fn extracts_the_host_from_common_remote_url_forms() {
        assert_eq!(remote_host("https://github.com/me/repo.git\n").as_deref(), Some("github.com"));
        assert_eq!(remote_host("git@bitbucket.org:team/repo.git").as_deref(), Some("bitbucket.org"));
        assert_eq!(remote_host("ssh://git@gitlab.example.com:2222/a/b.git").as_deref(), Some("gitlab.example.com"));
        assert_eq!(remote_host("https://user:token@github.com/me/repo").as_deref(), Some("github.com"));
        assert_eq!(remote_host("../local/repo"), None);
        assert_eq!(remote_host(r"C:\repos\origin.git"), None);
    }
}
