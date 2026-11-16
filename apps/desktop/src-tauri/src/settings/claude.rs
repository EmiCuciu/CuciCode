use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::AppResult;
use crate::jsonfile::read_optional;
use crate::paths::{claude_config_dir, managed_settings_dir};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
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

pub fn resolve_for_project(project_path: &Path) -> AppResult<Vec<ResolvedSetting>> {
    Ok(resolve(&load_sources(&SettingsLocations::system()?, Some(project_path))?))
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
