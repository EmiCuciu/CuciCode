use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::{AppError, AppResult};
use crate::jsonfile::{read_optional, write_atomic};
use crate::paths::{claude_config_dir, CUCICODE_DIR};

pub const SETTINGS_VERSION: u64 = 1;
const LOCAL_IGNORE_ENTRY: &str = ".claude/cucicode/settings.local.json";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUiSettings {
    #[serde(default)]
    pub hidden_categories: Vec<String>,
}

pub fn user_settings_path() -> AppResult<PathBuf> {
    Ok(claude_config_dir()?.join(CUCICODE_DIR).join("settings.json"))
}

pub fn project_local_settings_path(project_path: &Path) -> PathBuf {
    project_path.join(".claude").join(CUCICODE_DIR).join("settings.local.json")
}

/// Reads a CuciCode settings file as a JSON object, rejecting files written by a newer version.
pub fn load_document(path: &Path) -> AppResult<Map<String, Value>> {
    let document = match read_optional(path)? {
        None => Map::new(),
        Some(Value::Object(object)) => object,
        Some(_) => return Err(AppError::Invalid(format!("{} must contain a JSON object", path.display()))),
    };
    let version = document.get("version").and_then(Value::as_u64).unwrap_or(SETTINGS_VERSION);
    if version > SETTINGS_VERSION {
        return Err(AppError::Invalid(format!(
            "{} was written by a newer CuciCode (version {version}); this build understands version {SETTINGS_VERSION}",
            path.display()
        )));
    }
    Ok(document)
}

pub fn save_document(path: &Path, mut document: Map<String, Value>) -> AppResult<()> {
    document.insert("version".into(), json!(SETTINGS_VERSION));
    write_atomic(path, &Value::Object(document))
}

pub fn read_project_ui(project_path: &Path) -> AppResult<ProjectUiSettings> {
    let document = load_document(&project_local_settings_path(project_path))?;
    let hidden_categories = document
        .get("timeline")
        .and_then(|timeline| timeline.get("hiddenCategories"))
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default();
    Ok(ProjectUiSettings { hidden_categories })
}

pub fn write_project_ui(project_path: &Path, settings: &ProjectUiSettings) -> AppResult<()> {
    let path = project_local_settings_path(project_path);
    let mut document = load_document(&path)?;
    let timeline = document.entry("timeline").or_insert_with(|| json!({}));
    if !timeline.is_object() {
        *timeline = json!({});
    }
    timeline["hiddenCategories"] = json!(settings.hidden_categories);
    save_document(&path, document)?;
    ensure_git_ignored(project_path)
}

fn ensure_git_ignored(project_path: &Path) -> AppResult<()> {
    if !project_path.join(".git").exists() {
        return Ok(());
    }
    let gitignore = project_path.join(".gitignore");
    let existing = fs::read_to_string(&gitignore).unwrap_or_default();
    if existing.lines().any(|line| line.trim() == LOCAL_IGNORE_ENTRY) {
        return Ok(());
    }
    let separator = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
    fs::write(&gitignore, format!("{existing}{separator}{LOCAL_IGNORE_ENTRY}\n"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cucicode-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_reads_as_defaults() {
        let project = temp_project("defaults");
        assert_eq!(read_project_ui(&project).unwrap(), ProjectUiSettings::default());
        fs::remove_dir_all(&project).unwrap();
    }

    #[test]
    fn write_round_trips_and_keeps_unrelated_keys() {
        let project = temp_project("roundtrip");
        let path = project_local_settings_path(&project);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"version":1,"budgets":{"maxTurns":5},"timeline":{"density":"compact"}}"#).unwrap();
        let settings = ProjectUiSettings { hidden_categories: vec!["hook".into(), "system".into()] };
        write_project_ui(&project, &settings).unwrap();
        assert_eq!(read_project_ui(&project).unwrap(), settings);
        let document = load_document(&path).unwrap();
        assert_eq!(document["budgets"]["maxTurns"], json!(5));
        assert_eq!(document["timeline"]["density"], json!("compact"));
        assert!(!project.join(".gitignore").exists(), "no .gitignore outside a git repository");
        fs::remove_dir_all(&project).unwrap();
    }

    #[test]
    fn adds_the_local_file_to_gitignore_once_in_a_git_repository() {
        let project = temp_project("gitignore");
        fs::create_dir_all(project.join(".git")).unwrap();
        fs::write(project.join(".gitignore"), "node_modules/").unwrap();
        write_project_ui(&project, &ProjectUiSettings::default()).unwrap();
        write_project_ui(&project, &ProjectUiSettings::default()).unwrap();
        let ignore = fs::read_to_string(project.join(".gitignore")).unwrap();
        assert_eq!(ignore, format!("node_modules/\n{LOCAL_IGNORE_ENTRY}\n"));
        fs::remove_dir_all(&project).unwrap();
    }

    #[test]
    fn rejects_a_file_from_a_newer_version() {
        let project = temp_project("newer");
        let path = project_local_settings_path(&project);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{"version":99}"#).unwrap();
        assert!(read_project_ui(&project).is_err());
        fs::remove_dir_all(&project).unwrap();
    }
}
