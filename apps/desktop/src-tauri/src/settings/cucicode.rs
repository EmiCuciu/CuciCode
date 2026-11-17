use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::{AppError, AppResult};
use crate::jsonfile::{read_optional, write_atomic};
use crate::paths::{claude_config_dir, CUCICODE_DIR};

pub const SETTINGS_VERSION: u64 = 1;
const LOCAL_IGNORE_ENTRY: &str = ".claude/cucicode/*.local.json";
const RESERVED_USER_KEYS: [&str; 3] = ["version", "projects", "secretNames"];

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

pub fn project_shared_settings_path(project_path: &Path) -> PathBuf {
    project_path.join(".claude").join(CUCICODE_DIR).join("settings.json")
}

pub fn pipeline_state_path(project_path: &Path) -> PathBuf {
    project_path.join(".claude").join(CUCICODE_DIR).join("pipeline.local.json")
}

/// The project's shared and personal CuciCode settings, as stored.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProjectSettings {
    pub shared: Map<String, Value>,
    pub local: Map<String, Value>,
}

pub fn read_project_settings(project_path: &Path) -> AppResult<ProjectSettings> {
    Ok(ProjectSettings {
        shared: load_document(&project_shared_settings_path(project_path))?,
        local: load_document(&project_local_settings_path(project_path))?,
    })
}

/// Sets or removes one top-level section (for example "pipeline" or "git") in the shared or personal file.
pub fn set_project_setting(project_path: &Path, local: bool, key: &str, value: Option<Value>) -> AppResult<()> {
    if key.is_empty() || key == "version" {
        return Err(AppError::Invalid("a settings section name is required".into()));
    }
    let path = if local { project_local_settings_path(project_path) } else { project_shared_settings_path(project_path) };
    let mut document = load_document(&path)?;
    match value {
        Some(value) => {
            document.insert(key.to_owned(), value);
        }
        None => {
            document.shift_remove(key);
        }
    }
    save_document(&path, document)?;
    if local {
        ensure_git_ignored(project_path)?;
    }
    Ok(())
}

/// Looks a value up by path, preferring the personal file over the shared one.
pub fn effective_setting(settings: &ProjectSettings, path: &[&str]) -> Option<Value> {
    let lookup = |document: &Map<String, Value>| {
        let mut current = document.get(*path.first()?)?;
        for key in &path[1..] {
            current = current.get(key)?;
        }
        Some(current.clone())
    };
    lookup(&settings.local).or_else(|| lookup(&settings.shared))
}

/// Returns the app-wide sections of the user-level file, leaving out the keys owned by other modules.
pub fn read_user_settings(path: &Path) -> AppResult<Map<String, Value>> {
    let mut document = load_document(path)?;
    document.retain(|key, _| !RESERVED_USER_KEYS.contains(&key.as_str()));
    Ok(document)
}

/// Writes one app-wide section into the user-level file, reloading it first so every other key stays as stored.
pub fn set_user_setting(path: &Path, key: &str, value: Value) -> AppResult<()> {
    if key.is_empty() || RESERVED_USER_KEYS.contains(&key) {
        return Err(AppError::Invalid(format!("\"{key}\" cannot be written as an app setting")));
    }
    let mut document = load_document(path)?;
    document.insert(key.to_owned(), value);
    save_document(path, document)
}

pub fn read_pipeline_state(project_path: &Path) -> AppResult<Value> {
    Ok(Value::Object(load_document(&pipeline_state_path(project_path))?))
}

pub fn write_pipeline_state(project_path: &Path, state: Value) -> AppResult<()> {
    let Value::Object(document) = state else {
        return Err(AppError::Invalid("pipeline state must be a JSON object".into()));
    };
    save_document(&pipeline_state_path(project_path), document)?;
    ensure_git_ignored(project_path)
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
    fn project_settings_keep_shared_and_personal_apart_and_personal_wins() {
        let project = temp_project("sections");
        set_project_setting(&project, false, "git", Some(json!({ "maxParallelWorktrees": 2, "pushMode": "local" }))).unwrap();
        set_project_setting(&project, true, "git", Some(json!({ "maxParallelWorktrees": 4 }))).unwrap();
        let settings = read_project_settings(&project).unwrap();
        assert_eq!(settings.shared["git"]["pushMode"], json!("local"));
        assert_eq!(effective_setting(&settings, &["git", "maxParallelWorktrees"]), Some(json!(4)));
        assert_eq!(effective_setting(&settings, &["git", "pushMode"]), Some(json!("local")));
        assert_eq!(effective_setting(&settings, &["git", "missing"]), None);
        set_project_setting(&project, true, "git", None).unwrap();
        assert_eq!(effective_setting(&read_project_settings(&project).unwrap(), &["git", "maxParallelWorktrees"]), Some(json!(2)));
        assert!(set_project_setting(&project, false, "version", Some(json!(9))).is_err());
        fs::remove_dir_all(&project).unwrap();
    }

    #[test]
    fn pipeline_state_round_trips_and_must_be_an_object() {
        let project = temp_project("state");
        let mut state = read_pipeline_state(&project).unwrap();
        assert!(state.as_object().unwrap().is_empty());
        state = json!({ "features": { "auth": { "stage": "plan" } } });
        write_pipeline_state(&project, state).unwrap();
        assert_eq!(read_pipeline_state(&project).unwrap()["features"]["auth"]["stage"], json!("plan"));
        assert!(write_pipeline_state(&project, json!([1, 2])).is_err());
        fs::remove_dir_all(&project).unwrap();
    }

    #[test]
    fn user_settings_of_a_missing_file_are_empty() {
        let dir = temp_project("user-missing");
        assert!(read_user_settings(&dir.join("settings.json")).unwrap().is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn user_setting_round_trips_and_keeps_other_keys() {
        let dir = temp_project("user-roundtrip");
        let path = dir.join("settings.json");
        fs::write(&path, r#"{"version":1,"projects":[{"id":"a"}],"secretNames":["TOKEN"],"other":1}"#).unwrap();
        set_user_setting(&path, "chat", json!({ "timestamps": { "show": false } })).unwrap();
        let settings = read_user_settings(&path).unwrap();
        assert_eq!(settings["chat"]["timestamps"]["show"], json!(false));
        assert_eq!(settings["other"], json!(1));
        assert!(!settings.contains_key("projects"));
        let document = load_document(&path).unwrap();
        assert_eq!(document["projects"], json!([{ "id": "a" }]));
        assert_eq!(document["secretNames"], json!(["TOKEN"]));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn user_setting_refuses_reserved_keys_without_touching_the_file() {
        let dir = temp_project("user-reserved");
        let path = dir.join("settings.json");
        let original = r#"{"version":1,"projects":[],"secretNames":[]}"#;
        fs::write(&path, original).unwrap();
        for key in RESERVED_USER_KEYS {
            assert!(set_user_setting(&path, key, json!(2)).is_err());
        }
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn user_settings_reject_a_file_from_a_newer_version() {
        let dir = temp_project("user-newer");
        let path = dir.join("settings.json");
        fs::write(&path, r#"{"version":99}"#).unwrap();
        assert!(read_user_settings(&path).is_err());
        assert!(set_user_setting(&path, "chat", json!({})).is_err());
        fs::remove_dir_all(&dir).unwrap();
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
