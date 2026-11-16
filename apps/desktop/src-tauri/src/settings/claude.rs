use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};
use crate::jsonfile::{read_optional, write_atomic};
use crate::paths::{claude_config_dir, managed_settings_dir};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Managed,
    Local,
    Project,
    User,
}

#[derive(Debug, Clone)]
pub struct SettingsSource {
    pub scope: Scope,
    pub path: String,
    pub value: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSetting {
    pub key: String,
    pub value: Value,
    pub scope: Scope,
    pub path: String,
    pub merged_from: Vec<Scope>,
}

struct Leaf<'a> {
    scope: Scope,
    path: &'a str,
    value: &'a Value,
}

fn leaves<'a>(source: &'a SettingsSource, into: &mut BTreeMap<String, Vec<Leaf<'a>>>) {
    let Some(object) = source.value.as_object() else {
        return;
    };
    for (key, value) in object {
        if key == "$schema" {
            continue;
        }
        match value.as_object() {
            Some(children) if !children.is_empty() => {
                for (child, child_value) in children {
                    into.entry(format!("{key}.{child}")).or_default().push(Leaf {
                        scope: source.scope,
                        path: &source.path,
                        value: child_value,
                    });
                }
            }
            _ => into.entry(key.clone()).or_default().push(Leaf {
                scope: source.scope,
                path: &source.path,
                value,
            }),
        }
    }
}

/// Resolves effective settings from sources ordered from highest to lowest precedence.
///
/// A scalar takes the value of the highest scope that defines it. Arrays are combined
/// across scopes, highest first, without duplicates. Objects are resolved one level
/// deep, so `permissions.allow` and `env.NAME` are separate keys.
pub fn resolve(sources: &[SettingsSource]) -> Vec<ResolvedSetting> {
    let mut by_key: BTreeMap<String, Vec<Leaf>> = BTreeMap::new();
    for source in sources {
        leaves(source, &mut by_key);
    }
    by_key
        .into_iter()
        .filter_map(|(key, entries)| {
            let winner = entries.first()?;
            let all_arrays = entries.len() > 1 && entries.iter().all(|entry| entry.value.is_array());
            let (value, merged_from) = if all_arrays {
                let mut combined: Vec<Value> = Vec::new();
                for item in entries.iter().filter_map(|entry| entry.value.as_array()).flatten() {
                    if !combined.contains(item) {
                        combined.push(item.clone());
                    }
                }
                (Value::Array(combined), entries.iter().map(|entry| entry.scope).collect())
            } else {
                (winner.value.clone(), vec![winner.scope])
            };
            Some(ResolvedSetting {
                key,
                value,
                scope: winner.scope,
                path: winner.path.to_string(),
                merged_from,
            })
        })
        .collect()
}

fn merge_objects(base: &mut Map<String, Value>, overlay: Map<String, Value>) {
    for (key, value) in overlay {
        base.insert(key, value);
    }
}

fn managed_file_source(dir: &Path) -> AppResult<Option<SettingsSource>> {
    let main = dir.join("managed-settings.json");
    let mut merged = Map::new();
    let mut found = false;
    if let Some(Value::Object(object)) = read_optional(&main)? {
        merge_objects(&mut merged, object);
        found = true;
    }
    let drop_in_dir = dir.join("managed-settings.d");
    if let Ok(entries) = fs::read_dir(&drop_in_dir) {
        let mut files: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "json"))
            .collect();
        files.sort();
        for file in files {
            if let Some(Value::Object(object)) = read_optional(&file)? {
                merge_objects(&mut merged, object);
                found = true;
            }
        }
    }
    Ok(found.then(|| SettingsSource {
        scope: Scope::Managed,
        path: main.display().to_string(),
        value: Value::Object(merged),
    }))
}

#[cfg(windows)]
fn registry_policy(hive: winreg::HKEY, label: &str) -> Option<SettingsSource> {
    const KEY: &str = r"SOFTWARE\Policies\ClaudeCode";
    let text: String = winreg::RegKey::predef(hive).open_subkey(KEY).ok()?.get_value("Settings").ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    Some(SettingsSource {
        scope: Scope::Managed,
        path: format!(r"{label}\{KEY}\Settings"),
        value,
    })
}

#[cfg(windows)]
fn machine_policy() -> Option<SettingsSource> {
    registry_policy(winreg::enums::HKEY_LOCAL_MACHINE, "HKLM")
}

#[cfg(windows)]
fn user_policy() -> Option<SettingsSource> {
    registry_policy(winreg::enums::HKEY_CURRENT_USER, "HKCU")
}

#[cfg(not(windows))]
fn machine_policy() -> Option<SettingsSource> {
    None
}

#[cfg(not(windows))]
fn user_policy() -> Option<SettingsSource> {
    None
}

/// Where settings are read from. Tests point this at temporary directories.
pub struct SettingsLocations {
    pub config_dir: PathBuf,
    pub managed_dir: PathBuf,
    pub read_os_policy: bool,
}

impl SettingsLocations {
    pub fn system() -> AppResult<Self> {
        Ok(Self { config_dir: claude_config_dir()?, managed_dir: managed_settings_dir(), read_os_policy: true })
    }
}

fn managed_source(locations: &SettingsLocations) -> AppResult<Option<SettingsSource>> {
    if let Some(policy) = locations.read_os_policy.then(machine_policy).flatten() {
        return Ok(Some(policy));
    }
    if let Some(file) = managed_file_source(&locations.managed_dir)? {
        return Ok(Some(file));
    }
    Ok(locations.read_os_policy.then(user_policy).flatten())
}

fn file_source(scope: Scope, path: PathBuf) -> AppResult<Option<SettingsSource>> {
    Ok(read_optional(&path)?.map(|value| SettingsSource {
        scope,
        path: path.display().to_string(),
        value,
    }))
}

/// Loads every settings file that exists, ordered from highest to lowest precedence.
pub fn load_sources(locations: &SettingsLocations, project_path: Option<&Path>) -> AppResult<Vec<SettingsSource>> {
    let mut candidates = vec![managed_source(locations)?];
    if let Some(project_path) = project_path {
        let project_claude = project_path.join(".claude");
        candidates.push(file_source(Scope::Local, project_claude.join("settings.local.json"))?);
        candidates.push(file_source(Scope::Project, project_claude.join("settings.json"))?);
    }
    candidates.push(file_source(Scope::User, locations.config_dir.join("settings.json"))?);
    Ok(candidates.into_iter().flatten().collect())
}

/// One settings file as the editor sees it, whether or not it exists yet.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeFile {
    pub scope: Scope,
    pub path: String,
    pub exists: bool,
    pub writable: bool,
    pub value: Value,
}

fn writable_file(locations: &SettingsLocations, scope: Scope, project_path: Option<&Path>) -> AppResult<PathBuf> {
    let project = || project_path.map(|project| project.join(".claude")).ok_or_else(|| AppError::Invalid("select a project to edit project settings".into()));
    match scope {
        Scope::User => Ok(locations.config_dir.join("settings.json")),
        Scope::Project => Ok(project()?.join("settings.json")),
        Scope::Local => Ok(project()?.join("settings.local.json")),
        Scope::Managed => Err(AppError::Invalid("managed settings are set by your organisation and cannot be edited here".into())),
    }
}

/// Lists the managed source (if any) and every file the user can write to.
pub fn scope_files(locations: &SettingsLocations, project_path: Option<&Path>) -> AppResult<Vec<ScopeFile>> {
    let mut files: Vec<ScopeFile> = managed_source(locations)?
        .into_iter()
        .map(|source| ScopeFile { scope: Scope::Managed, path: source.path, exists: true, writable: false, value: source.value })
        .collect();
    let scopes: &[Scope] = if project_path.is_some() { &[Scope::Local, Scope::Project, Scope::User] } else { &[Scope::User] };
    for scope in scopes {
        let path = writable_file(locations, *scope, project_path)?;
        let value = read_optional(&path)?;
        files.push(ScopeFile { scope: *scope, path: path.display().to_string(), exists: value.is_some(), writable: true, value: value.unwrap_or_else(|| Value::Object(Map::new())) });
    }
    Ok(files)
}

/// Sets or removes one top-level key in the settings file of a scope, leaving every other key untouched.
pub fn set_value(locations: &SettingsLocations, scope: Scope, project_path: Option<&Path>, key: &str, value: Option<Value>) -> AppResult<()> {
    if key.is_empty() || key == "$schema" {
        return Err(AppError::Invalid("a setting key is required".into()));
    }
    let path = writable_file(locations, scope, project_path)?;
    let mut document = match read_optional(&path)? {
        None => Map::new(),
        Some(Value::Object(object)) => object,
        Some(_) => return Err(AppError::Invalid(format!("{} does not contain a JSON object", path.display()))),
    };
    match value {
        Some(value) => {
            document.insert(key.to_owned(), value);
        }
        None => {
            if document.shift_remove(key).is_none() {
                return Ok(());
            }
        }
    }
    write_atomic(&path, &Value::Object(document))
}

pub fn resolve_for_project(project_path: Option<&Path>) -> AppResult<Vec<ResolvedSetting>> {
    Ok(resolve(&load_sources(&SettingsLocations::system()?, project_path)?))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn source(scope: Scope, value: Value) -> SettingsSource {
        SettingsSource {
            scope,
            path: format!("{scope:?}.json"),
            value,
        }
    }

    fn find<'a>(resolved: &'a [ResolvedSetting], key: &str) -> &'a ResolvedSetting {
        resolved.iter().find(|setting| setting.key == key).expect("key should be resolved")
    }

    #[test]
    fn scalar_takes_the_highest_scope_that_defines_it() {
        let resolved = resolve(&[
            source(Scope::Local, json!({ "model": "opus" })),
            source(Scope::Project, json!({ "model": "sonnet", "outputStyle": "Concise" })),
            source(Scope::User, json!({ "model": "haiku", "effortLevel": "high" })),
        ]);
        assert_eq!(find(&resolved, "model").value, json!("opus"));
        assert_eq!(find(&resolved, "model").scope, Scope::Local);
        assert_eq!(find(&resolved, "model").merged_from, vec![Scope::Local]);
        assert_eq!(find(&resolved, "outputStyle").scope, Scope::Project);
        assert_eq!(find(&resolved, "effortLevel").scope, Scope::User);
    }

    #[test]
    fn arrays_are_combined_across_scopes_without_duplicates() {
        let resolved = resolve(&[
            source(Scope::Project, json!({ "permissions": { "allow": ["Bash(npm test)", "Read"] } })),
            source(Scope::User, json!({ "permissions": { "allow": ["Read", "Bash(git status)"], "deny": ["WebFetch"] } })),
        ]);
        let allow = find(&resolved, "permissions.allow");
        assert_eq!(allow.value, json!(["Bash(npm test)", "Read", "Bash(git status)"]));
        assert_eq!(allow.scope, Scope::Project);
        assert_eq!(allow.merged_from, vec![Scope::Project, Scope::User]);
        let deny = find(&resolved, "permissions.deny");
        assert_eq!(deny.scope, Scope::User);
        assert_eq!(deny.merged_from, vec![Scope::User]);
    }

    #[test]
    fn object_children_resolve_independently() {
        let resolved = resolve(&[
            source(Scope::Managed, json!({ "env": { "PROXY": "corp" } })),
            source(Scope::User, json!({ "env": { "PROXY": "mine", "DEBUG": "1" } })),
        ]);
        assert_eq!(find(&resolved, "env.PROXY").value, json!("corp"));
        assert_eq!(find(&resolved, "env.PROXY").scope, Scope::Managed);
        assert_eq!(find(&resolved, "env.DEBUG").scope, Scope::User);
    }

    #[test]
    fn schema_key_is_skipped_and_empty_objects_stay_whole() {
        let resolved = resolve(&[source(Scope::User, json!({ "$schema": "x", "hooks": {} }))]);
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].key, "hooks");
    }

    fn temp_locations(name: &str) -> (PathBuf, SettingsLocations, PathBuf) {
        let base = std::env::temp_dir().join(format!("cucicode-set-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let locations = SettingsLocations { config_dir: base.join("home/.claude"), managed_dir: base.join("managed"), read_os_policy: false };
        let project = base.join("project");
        fs::create_dir_all(&project).unwrap();
        (base, locations, project)
    }

    #[test]
    fn set_value_creates_the_file_and_keeps_other_keys_in_order() {
        let (base, locations, project) = temp_locations("create");
        let file = project.join(".claude/settings.json");
        set_value(&locations, Scope::Project, Some(&project), "model", Some(json!("opus"))).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "{\n  \"model\": \"opus\"\n}\n");

        fs::write(&file, r#"{"zeta": 1, "model": "opus", "alpha": {"keep": true}}"#).unwrap();
        set_value(&locations, Scope::Project, Some(&project), "model", Some(json!("sonnet"))).unwrap();
        let text = fs::read_to_string(&file).unwrap();
        let positions: Vec<usize> = ["zeta", "model", "alpha"].iter().map(|key| text.find(key).unwrap()).collect();
        assert!(positions[0] < positions[1] && positions[1] < positions[2], "key order must be preserved: {text}");
        assert!(text.contains("\"sonnet\"") && text.contains("\"keep\": true"));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn set_value_with_none_removes_only_that_key() {
        let (base, locations, project) = temp_locations("remove");
        let file = project.join(".claude/settings.local.json");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, r#"{"model":"opus","outputStyle":"Concise"}"#).unwrap();
        set_value(&locations, Scope::Local, Some(&project), "model", None).unwrap();
        assert_eq!(read_optional(&file).unwrap().unwrap(), json!({ "outputStyle": "Concise" }));
        set_value(&locations, Scope::Local, Some(&project), "absent", None).unwrap();
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn managed_scope_and_missing_project_are_refused() {
        let (base, locations, project) = temp_locations("refuse");
        assert!(set_value(&locations, Scope::Managed, Some(&project), "model", Some(json!("x"))).is_err());
        assert!(set_value(&locations, Scope::Project, None, "model", Some(json!("x"))).is_err());
        assert!(set_value(&locations, Scope::User, None, "", Some(json!("x"))).is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn scope_files_lists_writable_files_even_when_missing() {
        let (base, locations, project) = temp_locations("files");
        set_value(&locations, Scope::User, None, "model", Some(json!("haiku"))).unwrap();
        let files = scope_files(&locations, Some(&project)).unwrap();
        let summary: Vec<(Scope, bool, bool)> = files.iter().map(|file| (file.scope, file.exists, file.writable)).collect();
        assert_eq!(summary, vec![(Scope::Local, false, true), (Scope::Project, false, true), (Scope::User, true, true)]);
        assert_eq!(files[2].value, json!({ "model": "haiku" }));
        assert_eq!(scope_files(&locations, None).unwrap().len(), 1);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn managed_drop_ins_override_the_main_file_in_name_order() {
        let dir = std::env::temp_dir().join(format!("cucicode-managed-{}", std::process::id()));
        let drop_ins = dir.join("managed-settings.d");
        fs::create_dir_all(&drop_ins).unwrap();
        fs::write(dir.join("managed-settings.json"), r#"{"model":"a","outputStyle":"Concise"}"#).unwrap();
        fs::write(drop_ins.join("10-first.json"), r#"{"model":"b"}"#).unwrap();
        fs::write(drop_ins.join("20-second.json"), r#"{"model":"c"}"#).unwrap();
        let source = managed_file_source(&dir).unwrap().expect("managed source");
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(source.value, json!({ "model": "c", "outputStyle": "Concise" }));
        assert_eq!(source.scope, Scope::Managed);
    }
}
