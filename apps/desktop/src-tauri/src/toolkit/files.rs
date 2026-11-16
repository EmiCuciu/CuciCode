use std::fs;
use std::path::Path;

use serde_json::{json, Value};
use walkdir::WalkDir;

use super::frontmatter;
use super::model::{ItemKind, ItemScope, ToolkitItem};

const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_DEPTH: usize = 6;

pub struct Root<'a> {
    /// A `.claude`-style directory, or a plugin's root directory.
    pub dir: &'a Path,
    /// The directory `relative_path` is measured from.
    pub base: &'a Path,
    pub scope: ItemScope,
    pub plugin: Option<&'a str>,
}

fn relative(path: &Path, base: &Path) -> String {
    path.strip_prefix(base).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

fn text_field(frontmatter: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    frontmatter.get(key).and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned)
}

fn first_line(body: &str) -> Option<String> {
    body.lines()
        .map(|line| line.trim().trim_start_matches('#').trim())
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(160).collect())
}

fn command_name(file: &Path, commands_dir: &Path) -> String {
    relative(&file.with_extension(""), commands_dir).replace('/', ":")
}

pub fn item_from_file(kind: ItemKind, file: &Path, root: &Root, name_base: &Path) -> Option<ToolkitItem> {
    let metadata = fs::metadata(file).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return None;
    }
    let text = fs::read_to_string(file).ok()?;
    let document = frontmatter::parse(&text);
    let stem = file.file_stem()?.to_string_lossy().into_owned();
    let declared = text_field(&document.frontmatter, "name");
    let local_name = match kind {
        ItemKind::Skill => file.parent()?.file_name()?.to_string_lossy().into_owned(),
        ItemKind::Command => command_name(file, name_base),
        ItemKind::Rule => relative(file, name_base),
        ItemKind::Agent | ItemKind::OutputStyle => declared.clone().unwrap_or(stem),
        ItemKind::Hook | ItemKind::Mcp => return None,
    };
    let name = match (root.plugin, kind) {
        (Some(plugin), ItemKind::Agent | ItemKind::Skill | ItemKind::Command) => format!("{plugin}:{local_name}"),
        _ => local_name,
    };
    let description = text_field(&document.frontmatter, "description").or_else(|| match kind {
        ItemKind::Rule | ItemKind::Command => first_line(&document.body),
        _ => None,
    });
    let path = file.display().to_string();
    Some(ToolkitItem {
        id: format!("{}:{path}", kind.label()),
        kind,
        scope: root.scope,
        name,
        description,
        model: text_field(&document.frontmatter, "model"),
        relative_path: relative(file, root.base),
        path,
        plugin: root.plugin.map(str::to_owned),
        detail: json!({ "bodyLength": document.body.len() }),
        frontmatter: Value::Object(document.frontmatter),
        editable: !matches!(root.scope, ItemScope::Managed | ItemScope::Plugin),
        problem: document.error,
        conflict: None,
    })
}

fn markdown_files(dir: &Path) -> impl Iterator<Item = walkdir::DirEntry> {
    WalkDir::new(dir)
        .max_depth(MAX_DEPTH)
        .sort_by_file_name()
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| entry.path().extension().is_some_and(|extension| extension.eq_ignore_ascii_case("md")))
}

/// Scans one `.claude`-style directory (or plugin root) for file-based items.
pub fn scan_root(root: &Root) -> Vec<ToolkitItem> {
    let mut items = Vec::new();
    for kind in [ItemKind::Agent, ItemKind::Command, ItemKind::OutputStyle, ItemKind::Rule] {
        if kind == ItemKind::Rule && root.plugin.is_some() {
            continue;
        }
        let Some(folder) = kind.folder() else { continue };
        let dir = root.dir.join(folder);
        let name_base = if kind == ItemKind::Rule { root.dir } else { dir.as_path() };
        items.extend(markdown_files(&dir).filter_map(|entry| item_from_file(kind, entry.path(), root, name_base)));
    }
    let skills = root.dir.join("skills");
    items.extend(
        markdown_files(&skills)
            .filter(|entry| entry.file_name() == "SKILL.md")
            .filter_map(|entry| item_from_file(ItemKind::Skill, entry.path(), root, &skills)),
    );
    items
}

/// A standalone memory file such as `CLAUDE.md` or `CLAUDE.local.md`.
pub fn memory_file(file: &Path, base: &Path, scope: ItemScope) -> Option<ToolkitItem> {
    let root = Root { dir: base, base, scope, plugin: None };
    item_from_file(ItemKind::Rule, file, &root, base)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cucicode-toolkit-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn finds_every_file_based_kind_with_the_right_names() {
        let project = fixture("kinds");
        let claude = project.join(".claude");
        write(&claude.join("agents/review.md"), "---\nname: code-reviewer\ndescription: Reviews\nmodel: sonnet\n---\nPrompt");
        write(&claude.join("skills/deploy/SKILL.md"), "---\ndescription: Deploys\n---\nSteps");
        write(&claude.join("skills/deploy/notes.md"), "not a skill");
        write(&claude.join("commands/frontend/component.md"), "Make a component");
        write(&claude.join("output-styles/terse.md"), "---\nname: Terse\n---\nBe brief");
        write(&claude.join("rules/api/rest.md"), "---\npaths: src/api/**\n---\n# REST rules");
        let root = Root { dir: &claude, base: &project, scope: ItemScope::Project, plugin: None };
        let items = scan_root(&root);
        fs::remove_dir_all(&project).unwrap();

        let find = |kind: ItemKind| items.iter().find(|item| item.kind == kind).expect("item of kind");
        assert_eq!(items.len(), 5);
        assert_eq!(find(ItemKind::Agent).name, "code-reviewer");
        assert_eq!(find(ItemKind::Agent).model.as_deref(), Some("sonnet"));
        assert_eq!(find(ItemKind::Agent).relative_path, ".claude/agents/review.md");
        assert_eq!(find(ItemKind::Skill).name, "deploy");
        assert_eq!(find(ItemKind::Skill).description.as_deref(), Some("Deploys"));
        assert_eq!(find(ItemKind::Command).name, "frontend:component");
        assert_eq!(find(ItemKind::Command).description.as_deref(), Some("Make a component"));
        assert_eq!(find(ItemKind::OutputStyle).name, "Terse");
        assert_eq!(find(ItemKind::Rule).name, "rules/api/rest.md");
        assert_eq!(find(ItemKind::Rule).description.as_deref(), Some("REST rules"));
        assert!(items.iter().all(|item| item.editable));
    }

    #[test]
    fn plugin_items_are_namespaced_read_only_and_have_no_rules() {
        let plugin = fixture("plugin");
        write(&plugin.join("agents/reviewer.md"), "---\ndescription: x\n---\n");
        write(&plugin.join("skills/ship/SKILL.md"), "body");
        write(&plugin.join("rules/ignored.md"), "ignored");
        let root = Root { dir: &plugin, base: &plugin, scope: ItemScope::Plugin, plugin: Some("tools") };
        let items = scan_root(&root);
        fs::remove_dir_all(&plugin).unwrap();
        let names: Vec<&str> = items.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(names, vec!["tools:reviewer", "tools:ship"]);
        assert!(items.iter().all(|item| !item.editable && item.plugin.as_deref() == Some("tools")));
    }

    #[test]
    fn malformed_frontmatter_is_reported_not_dropped() {
        let project = fixture("broken");
        let claude = project.join(".claude");
        write(&claude.join("agents/broken.md"), "---\nname: [oops\n---\nbody");
        let root = Root { dir: &claude, base: &project, scope: ItemScope::Project, plugin: None };
        let items = scan_root(&root);
        fs::remove_dir_all(&project).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "broken");
        assert!(items[0].problem.as_deref().unwrap().contains("invalid YAML"));
    }
}
