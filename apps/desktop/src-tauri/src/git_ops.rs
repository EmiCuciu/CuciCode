use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::error::{AppError, AppResult};

const WORKTREES_DIR: &str = ".claude/worktrees";
const BRANCH_PREFIX: &str = "story/";
const MAX_PATCH_BYTES: usize = 400 * 1024;
const LOCAL_EXCLUDES: &[&str] = &[".claude/worktrees/", ".claude/cucicode/*.local.json"];

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Invalid(message.into())
}

fn command(dir: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command.arg("-C").arg(dir).args(args).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Runs git and returns stdout, or the error text git printed.
pub fn git(dir: &Path, args: &[&str]) -> AppResult<String> {
    let output = command(dir, args).output().map_err(|error| invalid(format!("cannot run git: {error}")))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(invalid(format!("git {} failed: {}", args.first().copied().unwrap_or_default(), stderr.trim())))
}

/// Like [`git`], but a failing command is `None` instead of an error.
pub fn git_optional(dir: &Path, args: &[&str]) -> Option<String> {
    git(dir, args).ok()
}

pub fn check_story_id(id: &str) -> AppResult<()> {
    let valid = !id.is_empty() && !id.starts_with('-') && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    valid.then_some(()).ok_or_else(|| invalid(format!("\"{id}\" is not a valid story id")))
}

pub fn worktree_path(project: &Path, id: &str) -> PathBuf {
    project.join(".claude").join("worktrees").join(id)
}

pub fn branch_name(id: &str) -> String {
    format!("{BRANCH_PREFIX}{id}")
}

/// The branch stories are cut from and merged into: the one checked out in the main working tree.
pub fn base_branch(project: &Path) -> AppResult<String> {
    let branch = git(project, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_owned();
    if branch.is_empty() || branch == "HEAD" {
        return Err(invalid("the project is not on a branch (detached HEAD); check out a branch first"));
    }
    Ok(branch)
}

/// Keeps worktrees and CuciCode's local state out of `git status` without touching the committed `.gitignore`.
fn ensure_local_excludes(project: &Path) -> AppResult<()> {
    let git_dir = git(project, &["rev-parse", "--git-common-dir"])?;
    let git_dir = project.join(git_dir.trim());
    let exclude = git_dir.join("info").join("exclude");
    let existing = fs::read_to_string(&exclude).unwrap_or_default();
    let missing: Vec<&str> = LOCAL_EXCLUDES.iter().copied().filter(|entry| !existing.lines().any(|line| line.trim() == *entry)).collect();
    if missing.is_empty() {
        return Ok(());
    }
    if let Some(parent) = exclude.parent() {
        fs::create_dir_all(parent)?;
    }
    let separator = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
    fs::write(&exclude, format!("{existing}{separator}{}\n", missing.join("\n")))?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub story_id: String,
    pub path: String,
    pub branch: String,
    pub head: String,
    pub dirty: bool,
    pub commits_ahead: u32,
    pub changed_files: u32,
}

/// Parses `git worktree list --porcelain` into `(path, head, branch)` entries.
pub fn parse_worktree_list(porcelain: &str) -> Vec<(String, String, String)> {
    let mut entries = Vec::new();
    let (mut path, mut head, mut branch) = (String::new(), String::new(), String::new());
    for line in porcelain.lines().chain(std::iter::once("")) {
        if let Some(value) = line.strip_prefix("worktree ") {
            path = value.to_owned();
        } else if let Some(value) = line.strip_prefix("HEAD ") {
            head = value.to_owned();
        } else if let Some(value) = line.strip_prefix("branch ") {
            branch = value.trim_start_matches("refs/heads/").to_owned();
        } else if line.is_empty() && !path.is_empty() {
            entries.push((std::mem::take(&mut path), std::mem::take(&mut head), std::mem::take(&mut branch)));
        }
    }
    entries
}

fn describe(project: &Path, base: &str, path: &str, head: &str, branch: &str) -> Option<Worktree> {
    let story_id = branch.strip_prefix(BRANCH_PREFIX)?.to_owned();
    let normalized = path.replace('\\', "/");
    if !normalized.contains(WORKTREES_DIR) {
        return None;
    }
    let dir = Path::new(path);
    let dirty = git_optional(dir, &["status", "--porcelain"]).is_some_and(|output| !output.trim().is_empty());
    let range = format!("{base}..{branch}");
    let commits_ahead = git_optional(project, &["rev-list", "--count", &range]).and_then(|count| count.trim().parse().ok()).unwrap_or(0);
    let changed_files = diff_stat(dir, base).map(|stat| stat.len() as u32).unwrap_or(0);
    Some(Worktree { story_id, path: path.to_owned(), branch: branch.to_owned(), head: head.chars().take(10).collect(), dirty, commits_ahead, changed_files })
}

pub fn worktree_list(project: &Path) -> AppResult<Vec<Worktree>> {
    let Some(porcelain) = git_optional(project, &["worktree", "list", "--porcelain"]) else {
        return Ok(Vec::new());
    };
    let base = base_branch(project)?;
    Ok(parse_worktree_list(&porcelain).iter().filter_map(|(path, head, branch)| describe(project, &base, path, head, branch)).collect())
}

/// Creates the worktree for a story on branch `story/<id>`, or returns the existing one.
pub fn worktree_add(project: &Path, id: &str) -> AppResult<Worktree> {
    check_story_id(id)?;
    let base = base_branch(project)?;
    if git_optional(project, &["rev-parse", "--verify", "HEAD"]).is_none() {
        return Err(invalid("the repository has no commits yet; make a first commit before building stories"));
    }
    ensure_local_excludes(project)?;
    let path = worktree_path(project, id);
    let branch = branch_name(id);
    if !path.exists() {
        let path_text = path.to_string_lossy();
        let branch_exists = git_optional(project, &["rev-parse", "--verify", &format!("refs/heads/{branch}")]).is_some();
        if branch_exists {
            git(project, &["worktree", "add", &path_text, &branch])?;
        } else {
            git(project, &["worktree", "add", "-b", &branch, &path_text, &base])?;
        }
    }
    worktree_list(project)?
        .into_iter()
        .find(|worktree| worktree.story_id == id)
        .ok_or_else(|| invalid(format!("the worktree for {id} was not created")))
}

pub fn worktree_remove(project: &Path, id: &str, delete_branch: bool) -> AppResult<()> {
    check_story_id(id)?;
    let path = worktree_path(project, id);
    if path.exists() {
        git(project, &["worktree", "remove", "--force", &path.to_string_lossy()])?;
    }
    git_optional(project, &["worktree", "prune"]);
    if delete_branch {
        git_optional(project, &["branch", "-D", &branch_name(id)]);
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

pub fn parse_numstat(output: &str) -> Vec<FileStat> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let added = parts.next()?;
            let removed = parts.next()?;
            let path = parts.next()?;
            Some(FileStat { path: path.to_owned(), added: added.parse().ok(), removed: removed.parse().ok() })
        })
        .collect()
}

fn merge_base(worktree: &Path, base: &str) -> AppResult<String> {
    Ok(git(worktree, &["merge-base", base, "HEAD"])?.trim().to_owned())
}

/// Files changed in a worktree since it branched off, including uncommitted edits.
fn diff_stat(worktree: &Path, base: &str) -> AppResult<Vec<FileStat>> {
    let from = merge_base(worktree, base)?;
    Ok(parse_numstat(&git(worktree, &["diff", "--numstat", &from])?))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryDiff {
    pub base: String,
    pub files: Vec<FileStat>,
    pub patch: String,
    pub truncated: bool,
}

pub fn story_diff(project: &Path, id: &str) -> AppResult<StoryDiff> {
    check_story_id(id)?;
    let worktree = worktree_path(project, id);
    if !worktree.is_dir() {
        return Err(invalid(format!("there is no worktree for {id}")));
    }
    let base = base_branch(project)?;
    let from = merge_base(&worktree, &base)?;
    let mut patch = git(&worktree, &["diff", &from])?;
    let truncated = patch.len() > MAX_PATCH_BYTES;
    if truncated {
        let mut end = MAX_PATCH_BYTES;
        while !patch.is_char_boundary(end) {
            end -= 1;
        }
        patch.truncate(end);
    }
    Ok(StoryDiff { files: parse_numstat(&git(&worktree, &["diff", "--numstat", &from])?), base, patch, truncated })
}

/// Merges a story branch into the base branch. A conflicting merge is aborted, leaving the base branch as it was.
pub fn merge_story(project: &Path, id: &str) -> AppResult<String> {
    check_story_id(id)?;
    let branch = branch_name(id);
    let worktree = worktree_path(project, id);
    if worktree.is_dir() && git(&worktree, &["status", "--porcelain"])?.lines().any(|line| !line.starts_with("??")) {
        return Err(invalid(format!("story {id} has uncommitted changes in its worktree; they would not be part of the merge")));
    }
    if git(project, &["status", "--porcelain"])?.lines().any(|line| !line.starts_with("??")) {
        return Err(invalid("the main working tree has uncommitted changes; commit or stash them before merging a story"));
    }
    let message = format!("Merge story {id}");
    match git(project, &["merge", "--no-ff", "-m", &message, &branch]) {
        Ok(_) => Ok(git(project, &["rev-parse", "--short", "HEAD"])?.trim().to_owned()),
        Err(error) => {
            git_optional(project, &["merge", "--abort"]);
            Err(invalid(format!("{error}. The merge was aborted and nothing changed; resolve the conflict in the story's worktree and try again.")))
        }
    }
}

/// Commits everything under one folder of the main working tree, if anything there changed.
pub fn commit_folder(project: &Path, folder: &str, message: &str) -> AppResult<bool> {
    git(project, &["add", "-A", "--", folder])?;
    if git(project, &["diff", "--cached", "--name-only", "--", folder])?.trim().is_empty() {
        return Ok(false);
    }
    git(project, &["commit", "-q", "-m", message, "--", folder])?;
    Ok(true)
}

pub fn push(project: &Path) -> AppResult<String> {
    let branch = base_branch(project)?;
    git(project, &["push", "origin", &branch])?;
    Ok(branch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_folder_commits_only_that_folder_and_reports_when_nothing_changed() {
        let dir = repo("commit-folder");
        fs::create_dir_all(dir.join("Stories")).unwrap();
        fs::write(dir.join("Stories/S-1.md"), "story").unwrap();
        fs::write(dir.join("other.txt"), "untouched").unwrap();
        assert!(commit_folder(&dir, "Stories", "archive").unwrap());
        assert!(!commit_folder(&dir, "Stories", "archive").unwrap());
        assert!(git(&dir, &["status", "--porcelain"]).unwrap().contains("other.txt"));
        assert!(git(&dir, &["log", "--oneline", "-1"]).unwrap().contains("archive"));
        cleanup(&dir);
    }

    fn repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cucicode-git-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]).unwrap();
        git(&dir, &["config", "user.email", "test@example.com"]).unwrap();
        git(&dir, &["config", "user.name", "Test"]).unwrap();
        git(&dir, &["config", "commit.gpgsign", "false"]).unwrap();
        git(&dir, &["config", "core.autocrlf", "false"]).unwrap();
        fs::write(dir.join("a.txt"), "one\n").unwrap();
        git(&dir, &["add", "."]).unwrap();
        git(&dir, &["commit", "-q", "-m", "init"]).unwrap();
        dir
    }

    fn cleanup(dir: &Path) {
        git_optional(dir, &["worktree", "prune"]);
        let _ = fs::remove_dir_all(dir);
    }

    fn commit_in(worktree: &Path, file: &str, content: &str, message: &str) {
        fs::write(worktree.join(file), content).unwrap();
        git(worktree, &["add", "."]).unwrap();
        git(worktree, &["commit", "-q", "-m", message]).unwrap();
    }

    #[test]
    fn parses_porcelain_worktree_output() {
        let entries = parse_worktree_list("worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/.claude/worktrees/S-1\nHEAD def\nbranch refs/heads/story/S-1\n");
        assert_eq!(entries, vec![("/repo".into(), "abc".into(), "main".into()), ("/repo/.claude/worktrees/S-1".into(), "def".into(), "story/S-1".into())]);
    }

    #[test]
    fn parses_numstat_including_binary_files() {
        let stats = parse_numstat("3\t1\tsrc/a.rs\n-\t-\tlogo.png\n");
        assert_eq!(stats[0], FileStat { path: "src/a.rs".into(), added: Some(3), removed: Some(1) });
        assert_eq!(stats[1], FileStat { path: "logo.png".into(), added: None, removed: None });
    }

    #[test]
    fn rejects_story_ids_that_are_not_plain_names() {
        for id in ["", "-x", "a/b", "a b", "../x"] {
            assert!(check_story_id(id).is_err(), "{id:?}");
        }
        assert!(check_story_id("S-001").is_ok());
    }

    #[test]
    fn a_story_worktree_can_be_created_diffed_merged_and_removed() {
        let dir = repo("flow");
        let worktree = worktree_add(&dir, "S-001").unwrap();
        assert_eq!(worktree.branch, "story/S-001");
        assert_eq!(worktree.commits_ahead, 0);
        assert!(git(&dir, &["status", "--porcelain"]).unwrap().trim().is_empty(), "worktrees must not show up as untracked files");
        assert_eq!(worktree_add(&dir, "S-001").unwrap().path, worktree.path, "adding twice returns the same worktree");

        let path = PathBuf::from(&worktree.path);
        commit_in(&path, "b.txt", "new\n", "S-001: add b");
        fs::write(path.join("a.txt"), "one\ntwo\n").unwrap();
        let listed = worktree_list(&dir).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].commits_ahead, listed[0].changed_files, listed[0].dirty), (1, 2, true));

        let diff = story_diff(&dir, "S-001").unwrap();
        assert_eq!(diff.base, "main");
        assert_eq!(diff.files.len(), 2);
        assert!(diff.patch.contains("+two") && diff.patch.contains("+new"));

        assert!(merge_story(&dir, "S-001").unwrap_err().to_string().contains("uncommitted"));
        git(&path, &["commit", "-q", "-am", "S-001: extend a"]).unwrap();
        merge_story(&dir, "S-001").unwrap();
        assert_eq!(fs::read_to_string(dir.join("b.txt")).unwrap(), "new\n");
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap().replace("\r\n", "\n"), "one\ntwo\n");

        worktree_remove(&dir, "S-001", true).unwrap();
        assert!(worktree_list(&dir).unwrap().is_empty());
        assert!(git_optional(&dir, &["rev-parse", "--verify", "refs/heads/story/S-001"]).is_none());
        cleanup(&dir);
    }

    #[test]
    fn a_conflicting_merge_is_aborted_and_leaves_the_base_branch_clean() {
        let dir = repo("conflict");
        let worktree = PathBuf::from(worktree_add(&dir, "S-002").unwrap().path);
        commit_in(&worktree, "a.txt", "story\n", "S-002: change a");
        commit_in(&dir, "a.txt", "main\n", "change a on main");
        let error = merge_story(&dir, "S-002").unwrap_err().to_string();
        assert!(error.contains("aborted"), "{error}");
        assert!(git(&dir, &["status", "--porcelain"]).unwrap().trim().is_empty());
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap().replace("\r\n", "\n"), "main\n");
        worktree_remove(&dir, "S-002", true).unwrap();
        cleanup(&dir);
    }

    #[test]
    fn a_repository_without_commits_is_refused_with_a_clear_message() {
        let dir = std::env::temp_dir().join(format!("cucicode-git-empty-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]).unwrap();
        assert!(worktree_add(&dir, "S-001").is_err());
        cleanup(&dir);
    }
}
