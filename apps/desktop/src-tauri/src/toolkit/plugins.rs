use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;

use super::model::{AvailablePlugin, Marketplace, PluginInfo};
use crate::error::AppResult;
use crate::jsonfile::read_optional;

fn same_path(left: &str, right: &Path) -> bool {
    let normalize = |text: &str| text.replace('\\', "/").trim_end_matches('/').to_lowercase();
    normalize(left) == normalize(&right.to_string_lossy())
}

fn split_id(id: &str) -> (String, Option<String>) {
    match id.split_once('@') {
        Some((name, marketplace)) => (name.to_owned(), Some(marketplace.to_owned())),
        None => (id.to_owned(), None),
    }
}

/// Reads `installed_plugins.json`. Entries installed for another project are skipped.
pub fn installed(plugins_dir: &Path, project: Option<&Path>, enabled: &HashMap<String, bool>) -> AppResult<Vec<PluginInfo>> {
    let Some(document) = read_optional(&plugins_dir.join("installed_plugins.json"))? else {
        return Ok(Vec::new());
    };
    let Some(entries) = document.get("plugins").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };
    let mut plugins = Vec::new();
    for (id, installs) in entries {
        let installs: Vec<&Value> = match installs {
            Value::Array(list) => list.iter().collect(),
            other => vec![other],
        };
        for install in installs {
            let Some(path) = install.get("installPath").and_then(Value::as_str) else {
                continue;
            };
            let for_other_project = install
                .get("projectPath")
                .and_then(Value::as_str)
                .is_some_and(|owner| project.is_none_or(|current| !same_path(owner, current)));
            if for_other_project {
                continue;
            }
            let (name, marketplace) = split_id(id);
            plugins.push(PluginInfo {
                id: id.clone(),
                name,
                marketplace,
                scope: install.get("scope").and_then(Value::as_str).unwrap_or("user").to_owned(),
                version: install.get("version").and_then(Value::as_str).map(str::to_owned),
                path: path.to_owned(),
                enabled: enabled.get(id).copied().unwrap_or(false),
            });
        }
    }
    plugins.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(plugins)
}

fn available_plugins(marketplace_dir: &Path) -> Vec<AvailablePlugin> {
    let manifest = marketplace_dir.join(".claude-plugin").join("marketplace.json");
    let Ok(Some(document)) = read_optional(&manifest) else {
        return Vec::new();
    };
    document
        .get("plugins")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|plugin| {
            Some(AvailablePlugin {
                name: plugin.get("name")?.as_str()?.to_owned(),
                description: plugin.get("description").and_then(Value::as_str).map(str::to_owned),
            })
        })
        .collect()
}

pub fn marketplaces(plugins_dir: &Path) -> AppResult<Vec<Marketplace>> {
    let Some(Value::Object(known)) = read_optional(&plugins_dir.join("known_marketplaces.json"))? else {
        return Ok(Vec::new());
    };
    let mut list: Vec<Marketplace> = known
        .into_iter()
        .map(|(name, entry)| {
            let path = entry.get("installLocation").and_then(Value::as_str).unwrap_or_default().to_owned();
            Marketplace {
                plugins: available_plugins(Path::new(&path)),
                source: entry.get("source").cloned().unwrap_or(Value::Null),
                last_updated: entry.get("lastUpdated").and_then(Value::as_str).map(str::to_owned),
                name,
                path,
            }
        })
        .collect();
    list.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(list)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn fixture(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cucicode-plugins-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_installs_and_skips_those_for_other_projects() {
        let dir = fixture("installed");
        fs::write(
            dir.join("installed_plugins.json"),
            r#"{"version":2,"plugins":{
                "fmt@team":[{"scope":"user","installPath":"/cache/fmt/1.0.0","version":"1.0.0"}],
                "lint@team":[{"scope":"project","installPath":"/cache/lint","projectPath":"C:\\work\\app"},
                             {"scope":"project","installPath":"/cache/lint-other","projectPath":"C:\\work\\other"}],
                "old":{"installPath":"/cache/old"}}}"#,
        )
        .unwrap();
        let enabled = HashMap::from([("fmt@team".to_owned(), true)]);
        let plugins = installed(&dir, Some(Path::new("C:/Work/App/")), &enabled).unwrap();
        fs::remove_dir_all(&dir).unwrap();
        let ids: Vec<(&str, &str, bool)> = plugins.iter().map(|plugin| (plugin.id.as_str(), plugin.path.as_str(), plugin.enabled)).collect();
        assert_eq!(ids, vec![("fmt@team", "/cache/fmt/1.0.0", true), ("lint@team", "/cache/lint", false), ("old", "/cache/old", false)]);
        assert_eq!(plugins[0].marketplace.as_deref(), Some("team"));
        assert_eq!(plugins[2].marketplace, None);
    }

    #[test]
    fn missing_files_mean_nothing_installed() {
        let dir = fixture("empty");
        assert!(installed(&dir, None, &HashMap::new()).unwrap().is_empty());
        assert!(marketplaces(&dir).unwrap().is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_marketplaces_with_their_available_plugins() {
        let dir = fixture("markets");
        let market = dir.join("marketplaces").join("team");
        fs::create_dir_all(market.join(".claude-plugin")).unwrap();
        fs::write(market.join(".claude-plugin").join("marketplace.json"), r#"{"name":"team","plugins":[{"name":"fmt","description":"Formats"},{"name":"lint"}]}"#).unwrap();
        let known = serde_json::json!({ "team": { "source": { "source": "git", "url": "https://bitbucket.org/t/r.git" }, "installLocation": market, "lastUpdated": "2026-11-16T09:00:00Z" } });
        fs::write(dir.join("known_marketplaces.json"), known.to_string()).unwrap();
        let list = marketplaces(&dir).unwrap();
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "team");
        assert_eq!(list[0].source["url"], serde_json::json!("https://bitbucket.org/t/r.git"));
        assert_eq!(list[0].plugins.len(), 2);
        assert_eq!(list[0].plugins[0].description.as_deref(), Some("Formats"));
    }
}
