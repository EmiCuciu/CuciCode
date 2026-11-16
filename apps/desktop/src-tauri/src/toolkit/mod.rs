mod conflicts;
pub mod edit;
mod embedded;
mod files;
pub mod validate;
pub mod watch;
pub mod frontmatter;
pub mod model;
mod plugins;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::error::AppResult;
use crate::jsonfile::read_optional;
use crate::paths::claude_user_state_file;
use crate::settings::claude::{load_sources, resolve, Scope, SettingsLocations};
use embedded::Origin;
use files::Root;
use model::{ItemScope, ToolkitItem, ToolkitScan};

fn display(path: &Path) -> String {
    path.display().to_string()
}

fn relative_to(path: &Path, base: &Path) -> String {
    path.strip_prefix(base).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

fn item_scope(scope: Scope) -> ItemScope {
    match scope {
        Scope::Managed => ItemScope::Managed,
        Scope::Local => ItemScope::Local,
        Scope::Project => ItemScope::Project,
        Scope::User => ItemScope::User,
    }
}

fn same_project(key: &str, project: &Path) -> bool {
    let normalize = |text: &str| text.replace('\\', "/").trim_end_matches('/').to_lowercase();
    normalize(key) == normalize(&project.to_string_lossy())
}

fn mcp_from_file(file: &Path, scope: ItemScope, relative_path: &str, plugin: Option<&str>, pick: impl Fn(&Value) -> Option<&Value>) -> AppResult<Vec<ToolkitItem>> {
    let Some(document) = read_optional(file)? else {
        return Ok(Vec::new());
    };
    let path = display(file);
    let origin = Origin { scope, path: &path, relative_path, plugin, editable: !matches!(scope, ItemScope::Managed | ItemScope::Plugin) };
    Ok(pick(&document).map(|servers| embedded::mcp_servers(servers, &origin)).unwrap_or_default())
}

struct Locations {
    settings: SettingsLocations,
    user_state: PathBuf,
}

fn scan_locations(locations: &Locations, project: Option<&Path>) -> AppResult<ToolkitScan> {
    let Locations { settings, user_state } = locations;
    let (config, managed) = (&settings.config_dir, &settings.managed_dir);
    let mut items = Vec::new();

    items.extend(files::scan_root(&Root { dir: config, base: config, scope: ItemScope::User, plugin: None }));
    items.extend(files::memory_file(&config.join("CLAUDE.md"), config, ItemScope::User));
    let managed_claude = managed.join(".claude");
    items.extend(files::scan_root(&Root { dir: &managed_claude, base: managed, scope: ItemScope::Managed, plugin: None }));
    items.extend(files::memory_file(&managed.join("CLAUDE.md"), managed, ItemScope::Managed));
    if let Some(project) = project {
        let project_claude = project.join(".claude");
        items.extend(files::scan_root(&Root { dir: &project_claude, base: project, scope: ItemScope::Project, plugin: None }));
        items.extend(files::memory_file(&project.join("CLAUDE.md"), project, ItemScope::Project));
        items.extend(files::memory_file(&project_claude.join("CLAUDE.md"), project, ItemScope::Project));
        items.extend(files::memory_file(&project.join("CLAUDE.local.md"), project, ItemScope::Local));
    }

    let sources = load_sources(settings, project)?;
    for source in &sources {
        let Some(hooks) = source.value.get("hooks") else { continue };
        let scope = item_scope(source.scope);
        let base = match scope {
            ItemScope::User => config.as_path(),
            ItemScope::Managed => managed.as_path(),
            _ => project.unwrap_or(config),
        };
        let relative_path = relative_to(Path::new(&source.path), base);
        let origin = Origin { scope, path: &source.path, relative_path: &relative_path, plugin: None, editable: scope != ItemScope::Managed };
        items.extend(embedded::hooks(hooks, &origin));
    }

    items.extend(mcp_from_file(user_state, ItemScope::User, ".claude.json", None, |document| document.get("mcpServers"))?);
    items.extend(mcp_from_file(&managed.join("managed-mcp.json"), ItemScope::Managed, "managed-mcp.json", None, |document| document.get("mcpServers"))?);
    if let Some(project) = project {
        items.extend(mcp_from_file(user_state, ItemScope::Local, ".claude.json", None, |document| {
            document
                .get("projects")?
                .as_object()?
                .iter()
                .find(|(key, _)| same_project(key, project))
                .and_then(|(_, entry)| entry.get("mcpServers"))
        })?);
        items.extend(mcp_from_file(&project.join(".mcp.json"), ItemScope::Project, ".mcp.json", None, |document| document.get("mcpServers"))?);
    }

    let enabled: HashMap<String, bool> = resolve(&sources)
        .into_iter()
        .filter_map(|setting| Some((setting.key.strip_prefix("enabledPlugins.")?.to_owned(), setting.value.as_bool()?)))
        .collect();
    let plugins_dir = config.join("plugins");
    let installed = plugins::installed(&plugins_dir, project, &enabled)?;
    for plugin in installed.iter().filter(|plugin| plugin.enabled) {
        let root = PathBuf::from(&plugin.path);
        let name = plugin.name.as_str();
        items.extend(files::scan_root(&Root { dir: &root, base: &root, scope: ItemScope::Plugin, plugin: Some(name) }));
        let hooks_file = root.join("hooks").join("hooks.json");
        if let Some(document) = read_optional(&hooks_file)? {
            let path = display(&hooks_file);
            let origin = Origin { scope: ItemScope::Plugin, path: &path, relative_path: "hooks/hooks.json", plugin: Some(name), editable: false };
            items.extend(embedded::hooks(document.get("hooks").unwrap_or(&document), &origin));
        }
        items.extend(mcp_from_file(&root.join(".mcp.json"), ItemScope::Plugin, ".mcp.json", Some(name), |document| {
            Some(document.get("mcpServers").unwrap_or(document))
        })?);
    }

    conflicts::annotate(&mut items);
    items.sort_by(|left, right| (left.kind.label(), left.name.to_lowercase(), left.scope as u8).cmp(&(right.kind.label(), right.name.to_lowercase(), right.scope as u8)));
    Ok(ToolkitScan { items, plugins: installed, marketplaces: plugins::marketplaces(&plugins_dir)? })
}

pub fn system_roots(project: Option<PathBuf>) -> AppResult<edit::Roots> {
    let settings = SettingsLocations::system()?;
    Ok(edit::Roots { config: settings.config_dir, managed: settings.managed_dir, project })
}

/// Lists everything Claude Code can load for a project (or globally when no project is given).
pub fn scan(project: Option<&Path>) -> AppResult<ToolkitScan> {
    let locations = Locations { settings: SettingsLocations::system()?, user_state: claude_user_state_file()? };
    scan_locations(&locations, project)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::model::ItemKind;
    use super::*;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    /// Run with `cargo test real_machine -- --ignored --nocapture` to see what the scanner finds here.
    #[test]
    #[ignore = "reads the real Claude Code configuration of this machine"]
    fn real_machine_scan_prints_a_summary() {
        let project = std::env::var_os("CUCICODE_SCAN_PROJECT").map(PathBuf::from);
        let scan = scan(project.as_deref()).unwrap();
        let mut counts: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
        for item in &scan.items {
            *counts.entry(format!("{}/{:?}", item.kind.label(), item.scope)).or_default() += 1;
        }
        println!("items: {counts:?}");
        println!("plugins: {}, marketplaces: {}", scan.plugins.len(), scan.marketplaces.len());
        for item in scan.items.iter().filter(|item| item.problem.is_some() || item.conflict.is_some()) {
            println!("  {} {} problem={:?} conflict={}", item.kind.label(), item.name, item.problem, item.conflict.is_some());
        }
    }

    #[test]
    fn scans_every_scope_and_reports_conflicts() {
        let root = std::env::temp_dir().join(format!("cucicode-scan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let config = root.join("home").join(".claude");
        let project = root.join("project");
        let plugin = root.join("cache").join("fmt");
        let project_key = project.display().to_string().replace('\\', "/");

        write(&config.join("agents/reviewer.md"), "---\ndescription: user reviewer\n---\n");
        write(&config.join("CLAUDE.md"), "# My rules");
        write(&config.join("settings.json"), r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"notify.sh"}]}]},"enabledPlugins":{"fmt@team":true}}"#);
        write(&config.join("plugins/installed_plugins.json"), &serde_json::json!({ "plugins": { "fmt@team": [{ "scope": "user", "installPath": plugin }] } }).to_string());
        write(&root.join("home/.claude.json"), &serde_json::json!({ "mcpServers": { "github": { "command": "gh-mcp" } }, "projects": { project_key: { "mcpServers": { "github": { "command": "local-gh" } } } } }).to_string());
        write(&project.join(".claude/agents/reviewer.md"), "---\ndescription: project reviewer\n---\n");
        write(&project.join(".claude/settings.json"), r#"{"hooks":{"PreToolUse":[{"matcher":"Edit","hooks":[{"type":"command","command":"guard.sh"}]}]}}"#);
        write(&project.join(".mcp.json"), r#"{"mcpServers":{"postgres":{"command":"pg-mcp"}}}"#);
        write(&project.join("CLAUDE.md"), "# Project rules");
        write(&project.join("CLAUDE.local.md"), "# Mine");
        write(&plugin.join("skills/format/SKILL.md"), "---\ndescription: Formats code\n---\n");
        write(&plugin.join("hooks/hooks.json"), r#"{"hooks":{"PostToolUse":[{"hooks":[{"type":"command","command":"fmt.sh"}]}]}}"#);

        let settings = SettingsLocations { config_dir: config.clone(), managed_dir: root.join("managed"), read_os_policy: false };
        let locations = Locations { settings, user_state: root.join("home/.claude.json") };
        let scan = scan_locations(&locations, Some(&project)).unwrap();
        fs::remove_dir_all(&root).unwrap();

        let of = |kind: ItemKind| scan.items.iter().filter(|item| item.kind == kind).collect::<Vec<_>>();
        let agents = of(ItemKind::Agent);
        assert_eq!(agents.len(), 2);
        let winning = agents.iter().find(|agent| agent.conflict.as_ref().unwrap().wins).unwrap();
        assert_eq!(winning.scope, ItemScope::Project);

        let hooks = of(ItemKind::Hook);
        let hook_scopes: Vec<(ItemScope, &str)> = hooks.iter().map(|hook| (hook.scope, hook.name.as_str())).collect();
        assert!(hook_scopes.contains(&(ItemScope::User, "Stop")));
        assert!(hook_scopes.contains(&(ItemScope::Project, "PreToolUse · Edit")));
        assert!(hook_scopes.contains(&(ItemScope::Plugin, "PostToolUse")));

        let mcp = of(ItemKind::Mcp);
        assert_eq!(mcp.len(), 3);
        let github_winner = mcp.iter().find(|server| server.name == "github" && server.conflict.as_ref().unwrap().wins).unwrap();
        assert_eq!(github_winner.scope, ItemScope::Local);
        assert!(mcp.iter().any(|server| server.name == "postgres" && server.scope == ItemScope::Project && server.conflict.is_none()));

        let rules: Vec<(ItemScope, &str)> = of(ItemKind::Rule).iter().map(|rule| (rule.scope, rule.name.as_str())).collect();
        assert!(rules.contains(&(ItemScope::User, "CLAUDE.md")));
        assert!(rules.contains(&(ItemScope::Project, "CLAUDE.md")));
        assert!(rules.contains(&(ItemScope::Local, "CLAUDE.local.md")));

        let skills = of(ItemKind::Skill);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "fmt:format");
        assert!(!skills[0].editable);
        assert_eq!(scan.plugins.len(), 1);
        assert!(scan.plugins[0].enabled);
    }
}
