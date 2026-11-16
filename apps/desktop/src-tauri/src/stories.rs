use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};
use crate::git_ops::worktree_path;
use crate::toolkit::frontmatter;

const DEFAULT_FOLDER: &str = "Stories";
const ARCHIVE: &str = "archive";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Story {
    pub id: String,
    pub feature: String,
    pub title: String,
    pub status: String,
    pub acceptance_criteria: Vec<String>,
    pub owned_files: Vec<String>,
    pub depends_on: Vec<String>,
    pub worker: Option<String>,
    pub branch: Option<String>,
    pub review: Option<String>,
    pub path: String,
    pub archived: bool,
    pub body: String,
    /// The status in the story's own worktree, when a worker has changed it there.
    pub worktree_status: Option<String>,
    pub problem: Option<String>,
}

/// Where stories are kept. The pipeline talks only to this trait, so another
/// target (for example Linear through its MCP server) can be added beside the folder.
pub trait StoriesTarget {
    fn list(&self) -> AppResult<Vec<Story>>;
    fn set_field(&self, id: &str, key: &str, value: Option<&str>) -> AppResult<()>;
    fn archive(&self, id: &str) -> AppResult<PathBuf>;
}

fn text(fields: &Map<String, Value>, key: &str) -> Option<String> {
    match fields.get(key)? {
        Value::String(value) if !value.trim().is_empty() => Some(value.trim().to_owned()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn list(fields: &Map<String, Value>, key: &str) -> Vec<String> {
    match fields.get(key) {
        Some(Value::Array(items)) => items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect(),
        Some(Value::String(item)) if !item.trim().is_empty() => vec![item.trim().to_owned()],
        _ => Vec::new(),
    }
}

fn id_from_file_name(path: &Path) -> String {
    let stem = path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
    let mut parts = stem.splitn(3, '-');
    match (parts.next(), parts.next()) {
        (Some(prefix), Some(number)) if number.chars().all(|c| c.is_ascii_digit()) && !number.is_empty() => format!("{prefix}-{number}"),
        _ => stem,
    }
}

pub fn parse_story(path: &Path, content: &str, archived: bool) -> Story {
    let document = frontmatter::parse(content);
    let fields = &document.frontmatter;
    let id = text(fields, "id").unwrap_or_else(|| id_from_file_name(path));
    Story {
        feature: text(fields, "feature").unwrap_or_default(),
        title: text(fields, "title").unwrap_or_else(|| id.clone()),
        status: text(fields, "status").unwrap_or_else(|| "todo".into()),
        acceptance_criteria: list(fields, "acceptance_criteria"),
        owned_files: list(fields, "owned_files"),
        depends_on: list(fields, "depends_on"),
        worker: text(fields, "worker"),
        branch: text(fields, "branch"),
        review: text(fields, "review"),
        path: path.display().to_string(),
        archived,
        body: document.body,
        worktree_status: None,
        problem: document.error,
        id,
    }
}

/// Sets one scalar key in the frontmatter, leaving every other line as it was.
pub fn update_frontmatter(content: &str, key: &str, value: Option<&str>) -> String {
    let line_ending = if content.contains("\r\n") { "\r\n" } else { "\n" };
    let rendered = format!("{key}: {}", value.unwrap_or("null"));
    let lines: Vec<&str> = content.lines().collect();
    let has_frontmatter = lines.first().is_some_and(|line| line.trim_end() == "---");
    let close = if has_frontmatter { lines.iter().skip(1).position(|line| line.trim_end() == "---").map(|index| index + 1) } else { None };
    let Some(close) = close else {
        return format!("---{line_ending}{rendered}{line_ending}---{line_ending}{content}");
    };
    let prefix = format!("{key}:");
    let mut output: Vec<String> = Vec::with_capacity(lines.len() + 1);
    let mut replaced = false;
    for (index, line) in lines.iter().enumerate() {
        if index > 0 && index < close && !replaced && line.starts_with(&prefix) {
            output.push(rendered.clone());
            replaced = true;
        } else {
            if index == close && !replaced {
                output.push(rendered.clone());
            }
            output.push((*line).to_owned());
        }
    }
    let mut result = output.join(line_ending);
    if content.ends_with('\n') {
        result.push_str(line_ending);
    }
    result
}

pub struct FolderTarget {
    project: PathBuf,
    folder: PathBuf,
}

impl FolderTarget {
    pub fn new(project: &Path, folder: Option<&str>) -> AppResult<Self> {
        let name = folder.map(str::trim).filter(|name| !name.is_empty()).unwrap_or(DEFAULT_FOLDER);
        let relative = Path::new(name);
        if relative.is_absolute() || relative.components().any(|component| !matches!(component, std::path::Component::Normal(_))) {
            return Err(AppError::Invalid(format!("the stories folder \"{name}\" must be a folder inside the project")));
        }
        Ok(Self { project: project.to_path_buf(), folder: project.join(relative) })
    }

    /// The stories folder relative to the project, with forward slashes, for git commands.
    pub fn folder_name(&self) -> String {
        self.folder.strip_prefix(&self.project).unwrap_or(&self.folder).to_string_lossy().replace('\\', "/")
    }

    fn read_dir(&self, dir: &Path, archived: bool) -> Vec<Story> {
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut files: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.is_file() && path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("md")))
            .collect();
        files.sort();
        files.iter().filter_map(|path| fs::read_to_string(path).ok().map(|content| parse_story(path, &content, archived))).collect()
    }

    fn find(&self, id: &str) -> AppResult<Story> {
        self.read_dir(&self.folder, false)
            .into_iter()
            .find(|story| story.id == id)
            .ok_or_else(|| AppError::Invalid(format!("story {id} was not found in {}", self.folder.display())))
    }

    fn worktree_status(&self, story: &Story) -> Option<String> {
        let relative = Path::new(&story.path).strip_prefix(&self.project).ok()?;
        let copy = worktree_path(&self.project, &story.id).join(relative);
        let content = fs::read_to_string(copy).ok()?;
        let status = parse_story(Path::new(&story.path), &content, false).status;
        (status != story.status).then_some(status)
    }
}

impl StoriesTarget for FolderTarget {
    fn list(&self) -> AppResult<Vec<Story>> {
        let mut stories = self.read_dir(&self.folder, false);
        for story in &mut stories {
            story.worktree_status = self.worktree_status(story);
        }
        stories.extend(self.read_dir(&self.folder.join(ARCHIVE), true));
        Ok(stories)
    }

    fn set_field(&self, id: &str, key: &str, value: Option<&str>) -> AppResult<()> {
        const EDITABLE: &[&str] = &["status", "worker", "branch", "review"];
        if !EDITABLE.contains(&key) {
            return Err(AppError::Invalid(format!("\"{key}\" cannot be changed here; edit the story file instead")));
        }
        if value.is_some_and(|value| value.contains(['\n', '\r', ':', '#'])) {
            return Err(AppError::Invalid("the value must be a single plain word".into()));
        }
        let story = self.find(id)?;
        let content = fs::read_to_string(&story.path)?;
        fs::write(&story.path, update_frontmatter(&content, key, value))?;
        Ok(())
    }

    fn archive(&self, id: &str) -> AppResult<PathBuf> {
        let story = self.find(id)?;
        let source = PathBuf::from(&story.path);
        let content = fs::read_to_string(&source)?;
        let archive = self.folder.join(ARCHIVE);
        fs::create_dir_all(&archive)?;
        let target = archive.join(source.file_name().unwrap_or_default());
        fs::write(&target, update_frontmatter(&content, "status", Some("done")))?;
        fs::remove_file(&source)?;
        Ok(target)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STORY: &str = "---\nid: S-001\nfeature: auth\ntitle: Add login form\nstatus: todo\nacceptance_criteria:\n  - shows an error on a wrong password\n  - redirects after login\nowned_files:\n  - src/login/**\ndepends_on: []\nworker: null\nbranch: null\nreview: null\n---\n\n## Story\n\nAs a user, I want to log in.\n";

    fn project(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cucicode-stories-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Stories")).unwrap();
        dir
    }

    #[test]
    fn parses_frontmatter_lists_and_nulls() {
        let story = parse_story(Path::new("Stories/S-001-login.md"), STORY, false);
        assert_eq!((story.id.as_str(), story.feature.as_str(), story.status.as_str()), ("S-001", "auth", "todo"));
        assert_eq!(story.acceptance_criteria.len(), 2);
        assert_eq!(story.owned_files, vec!["src/login/**"]);
        assert!(story.depends_on.is_empty());
        assert_eq!((story.worker, story.review), (None, None));
        assert!(story.body.contains("As a user"));
    }

    #[test]
    fn a_file_without_frontmatter_still_becomes_a_story_named_after_the_file() {
        let story = parse_story(Path::new("Stories/S-014-fix-header.md"), "Just text", false);
        assert_eq!((story.id.as_str(), story.status.as_str(), story.title.as_str()), ("S-014", "todo", "S-014"));
        assert_eq!(parse_story(Path::new("Stories/notes.md"), "x", false).id, "notes");
    }

    #[test]
    fn update_changes_one_line_and_keeps_the_rest_byte_for_byte() {
        let updated = update_frontmatter(STORY, "status", Some("in_progress"));
        assert_eq!(updated, STORY.replace("status: todo", "status: in_progress"));
        assert_eq!(update_frontmatter(&updated, "review", None), updated, "null stays null");
        let windows = STORY.replace('\n', "\r\n");
        assert_eq!(update_frontmatter(&windows, "worker", Some("w1")), windows.replace("worker: null", "worker: w1"));
    }

    #[test]
    fn update_adds_a_missing_key_or_missing_frontmatter() {
        assert_eq!(update_frontmatter("---\nid: S-1\n---\nBody\n", "status", Some("done")), "---\nid: S-1\nstatus: done\n---\nBody\n");
        assert_eq!(update_frontmatter("Body\n", "status", Some("done")), "---\nstatus: done\n---\nBody\n");
        assert_eq!(update_frontmatter("---\nid: S-1\n---\nstatus: in body\n", "status", Some("x")), "---\nid: S-1\nstatus: x\n---\nstatus: in body\n");
    }

    #[test]
    fn folder_target_lists_updates_and_archives() {
        let dir = project("target");
        fs::write(dir.join("Stories/S-001-login.md"), STORY).unwrap();
        fs::write(dir.join("Stories/S-002-logout.md"), STORY.replace("S-001", "S-002")).unwrap();
        let target = FolderTarget::new(&dir, None).unwrap();
        assert_eq!(target.list().unwrap().iter().map(|story| story.id.as_str()).collect::<Vec<_>>(), vec!["S-001", "S-002"]);

        target.set_field("S-001", "status", Some("review")).unwrap();
        assert!(target.set_field("S-001", "title", Some("x")).is_err());
        assert!(target.set_field("S-001", "status", Some("a: b")).is_err());
        assert!(target.set_field("S-404", "status", Some("x")).is_err());

        let archived = target.archive("S-001").unwrap();
        assert!(archived.ends_with("Stories/archive/S-001-login.md") || archived.ends_with(r"Stories\archive\S-001-login.md"));
        let stories = target.list().unwrap();
        let done = stories.iter().find(|story| story.id == "S-001").unwrap();
        assert!(done.archived);
        assert_eq!(done.status, "done");
        assert!(!stories.iter().find(|story| story.id == "S-002").unwrap().archived);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn shows_the_status_a_worker_set_in_its_worktree() {
        let dir = project("worktree");
        fs::write(dir.join("Stories/S-001-login.md"), STORY).unwrap();
        let copy = worktree_path(&dir, "S-001").join("Stories");
        fs::create_dir_all(&copy).unwrap();
        fs::write(copy.join("S-001-login.md"), STORY.replace("status: todo", "status: review")).unwrap();
        let stories = FolderTarget::new(&dir, None).unwrap().list().unwrap();
        assert_eq!(stories[0].status, "todo");
        assert_eq!(stories[0].worktree_status.as_deref(), Some("review"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_stories_folder_must_stay_inside_the_project() {
        let dir = project("folder");
        assert!(FolderTarget::new(&dir, Some("../elsewhere")).is_err());
        assert!(FolderTarget::new(&dir, Some("/abs")).is_err());
        assert!(FolderTarget::new(&dir, Some("docs/stories")).is_ok());
        fs::remove_dir_all(dir).unwrap();
    }
}
