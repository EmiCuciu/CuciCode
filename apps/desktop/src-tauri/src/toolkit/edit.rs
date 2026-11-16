use std::fs;
use std::path::{Component, Path, PathBuf};

use walkdir::WalkDir;

use super::model::{ItemKind, ItemScope};
use crate::error::{AppError, AppResult};

/// The directories CuciCode may touch. Tests point these at temporary folders.
pub struct Roots {
    pub config: PathBuf,
    pub managed: PathBuf,
    pub project: Option<PathBuf>,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Invalid(message.into())
}

fn normalized(path: &Path) -> AppResult<String> {
    if path.components().any(|component| matches!(component, Component::ParentDir)) {
        return Err(invalid(format!("{} must not contain \"..\"", path.display())));
    }
    if !path.is_absolute() {
        return Err(invalid(format!("{} must be an absolute path", path.display())));
    }
    Ok(path.to_string_lossy().replace('\\', "/").to_lowercase())
}

const PROJECT_MEMORY_FILES: &[&str] = &["CLAUDE.md", "CLAUDE.local.md"];

fn normalized_lossy(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn inside(path: &str, root: &Path) -> bool {
    let root = normalized_lossy(root);
    let root = root.trim_end_matches('/');
    path == root || path.strip_prefix(root).is_some_and(|rest| rest.starts_with('/'))
}

impl Roots {
    fn check_readable(&self, path: &Path) -> AppResult<()> {
        let normalized = normalized(path)?;
        let allowed = inside(&normalized, &self.config) || inside(&normalized, &self.managed) || self.project.as_deref().is_some_and(|project| inside(&normalized, project));
        allowed.then_some(()).ok_or_else(|| invalid(format!("{} is outside the Claude Code and project folders", path.display())))
    }

    fn check_writable(&self, path: &Path) -> AppResult<()> {
        let normalized = normalized(path)?;
        if inside(&normalized, &self.config.join("plugins")) {
            return Err(invalid("installed plugins are read-only; copy the item to your user or project scope to change it"));
        }
        let in_project = self.project.as_deref().is_some_and(|project| {
            inside(&normalized, &project.join(".claude")) || PROJECT_MEMORY_FILES.iter().any(|file| normalized == normalized_lossy(&project.join(file)))
        });
        (inside(&normalized, &self.config) || in_project)
            .then_some(())
            .ok_or_else(|| invalid(format!("{} is not in a scope CuciCode can write to", path.display())))
    }

    fn scope_dir(&self, scope: ItemScope) -> AppResult<PathBuf> {
        match scope {
            ItemScope::User => Ok(self.config.clone()),
            ItemScope::Project => self.project.as_ref().map(|project| project.join(".claude")).ok_or_else(|| invalid("select a project to use the project scope")),
            _ => Err(invalid("items can only be created in the user or project scope")),
        }
    }
}

fn valid_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !segment.starts_with('.')
        && !segment.ends_with('.')
}

/// The file an item of this kind and name lives in, relative to its scope directory.
pub fn item_file(kind: ItemKind, name: &str) -> AppResult<PathBuf> {
    let folder = kind.folder().ok_or_else(|| invalid("hooks and MCP servers are not stored as separate files"))?;
    let separator = match kind {
        ItemKind::Command => ':',
        ItemKind::Rule => '/',
        _ => '\0',
    };
    let name = name.strip_suffix(".md").unwrap_or(name);
    let segments: Vec<&str> = if separator == '\0' { vec![name] } else { name.split(separator).collect() };
    if !segments.iter().all(|segment| valid_segment(segment)) {
        return Err(invalid(format!("\"{name}\" is not a valid name: use letters, digits, - and _")));
    }
    let mut path = PathBuf::from(folder);
    path.extend(&segments);
    Ok(match kind {
        ItemKind::Skill => path.join("SKILL.md"),
        _ => path.with_extension("md"),
    })
}

pub fn read(roots: &Roots, path: &Path) -> AppResult<String> {
    roots.check_readable(path)?;
    Ok(fs::read_to_string(path)?)
}

pub fn write(roots: &Roots, path: &Path, content: &str) -> AppResult<()> {
    roots.check_writable(path)?;
    if !path.is_file() {
        return Err(invalid(format!("{} does not exist", path.display())));
    }
    let temporary = path.with_extension("md.tmp");
    fs::write(&temporary, content)?;
    fs::rename(&temporary, path)?;
    Ok(())
}

pub fn create(roots: &Roots, kind: ItemKind, scope: ItemScope, name: &str, content: &str) -> AppResult<PathBuf> {
    let path = roots.scope_dir(scope)?.join(item_file(kind, name)?);
    roots.check_writable(&path)?;
    if path.exists() {
        return Err(invalid(format!("{} already exists", path.display())));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, content)?;
    Ok(path)
}

/// What gets removed with an item: a skill is its whole folder, everything else one file.
fn unit(kind: ItemKind, path: &Path) -> AppResult<PathBuf> {
    match kind {
        ItemKind::Skill => path.parent().map(Path::to_path_buf).ok_or_else(|| invalid("a skill must be inside a folder")),
        ItemKind::Hook | ItemKind::Mcp => Err(invalid("hooks and MCP servers are edited through settings, not as files")),
        _ => Ok(path.to_path_buf()),
    }
}

pub fn delete(roots: &Roots, kind: ItemKind, path: &Path) -> AppResult<()> {
    roots.check_writable(path)?;
    let target = unit(kind, path)?;
    if target.is_dir() {
        fs::remove_dir_all(target)?;
    } else {
        fs::remove_file(target)?;
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> AppResult<()> {
    for entry in WalkDir::new(from).into_iter().filter_map(Result::ok) {
        let target = to.join(entry.path().strip_prefix(from).unwrap_or(entry.path()));
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn rename_in_frontmatter(content: &str, name: &str) -> String {
    let mut in_frontmatter = false;
    let mut done = false;
    let mut lines: Vec<String> = Vec::new();
    for (index, line) in content.lines().enumerate() {
        if line.trim_end() == "---" {
            in_frontmatter = index == 0;
            done = done || index > 0;
        } else if in_frontmatter && !done && line.starts_with("name:") {
            lines.push(format!("name: {name}"));
            done = true;
            continue;
        }
        lines.push(line.to_owned());
    }
    let mut result = lines.join("\n");
    if content.ends_with('\n') {
        result.push('\n');
    }
    result
}

/// Copies an item to another scope or name. With `remove_source` it is a move.
pub fn copy(roots: &Roots, kind: ItemKind, source: &Path, target_scope: ItemScope, new_name: &str, remove_source: bool) -> AppResult<PathBuf> {
    roots.check_readable(source)?;
    let target = roots.scope_dir(target_scope)?.join(item_file(kind, new_name)?);
    roots.check_writable(&target)?;
    if target.exists() {
        return Err(invalid(format!("{} already exists", target.display())));
    }
    if remove_source {
        roots.check_writable(source)?;
    }
    if kind == ItemKind::Skill {
        copy_dir(&unit(kind, source)?, &unit(kind, &target)?)?;
    } else {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let content = fs::read_to_string(source)?;
        let content = if matches!(kind, ItemKind::Agent | ItemKind::OutputStyle) { rename_in_frontmatter(&content, new_name) } else { content };
        fs::write(&target, content)?;
    }
    if remove_source {
        delete(roots, kind, source)?;
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(name: &str) -> (PathBuf, Roots) {
        let base = std::env::temp_dir().join(format!("cucicode-edit-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let roots = Roots { config: base.join("home/.claude"), managed: base.join("managed"), project: Some(base.join("project")) };
        fs::create_dir_all(&roots.config).unwrap();
        fs::create_dir_all(roots.project.as_ref().unwrap()).unwrap();
        (base, roots)
    }

    #[test]
    fn maps_names_to_files_per_kind() {
        let file = |kind, name| item_file(kind, name).unwrap().to_string_lossy().replace('\\', "/");
        assert_eq!(file(ItemKind::Agent, "code-reviewer"), "agents/code-reviewer.md");
        assert_eq!(file(ItemKind::Skill, "deploy"), "skills/deploy/SKILL.md");
        assert_eq!(file(ItemKind::Command, "frontend:component"), "commands/frontend/component.md");
        assert_eq!(file(ItemKind::OutputStyle, "terse"), "output-styles/terse.md");
        assert_eq!(file(ItemKind::Rule, "api/rest.md"), "rules/api/rest.md");
    }

    #[test]
    fn rejects_names_that_could_escape_the_folder() {
        for name in ["../evil", "a/b", "", ".hidden", "a b", "x:..:y"] {
            assert!(item_file(ItemKind::Agent, name).is_err(), "{name} should be rejected for an agent");
        }
        assert!(item_file(ItemKind::Command, "a:../b").is_err());
        assert!(item_file(ItemKind::Hook, "x").is_err());
    }

    #[test]
    fn create_write_read_delete_round_trip() {
        let (base, roots) = roots("roundtrip");
        let path = create(&roots, ItemKind::Agent, ItemScope::Project, "reviewer", "---\nname: reviewer\n---\nv1").unwrap();
        assert!(path.ends_with(".claude/agents/reviewer.md"));
        assert!(create(&roots, ItemKind::Agent, ItemScope::Project, "reviewer", "x").is_err(), "must not overwrite");
        write(&roots, &path, "v2").unwrap();
        assert_eq!(read(&roots, &path).unwrap(), "v2");
        delete(&roots, ItemKind::Agent, &path).unwrap();
        assert!(!path.exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn refuses_paths_outside_its_roots_and_inside_plugins() {
        let (base, roots) = roots("guard");
        let outside = base.join("elsewhere/secret.md");
        fs::create_dir_all(outside.parent().unwrap()).unwrap();
        fs::write(&outside, "secret").unwrap();
        assert!(read(&roots, &outside).is_err());
        assert!(write(&roots, &outside, "x").is_err());
        assert!(read(&roots, &roots.config.join("agents/../../../elsewhere/secret.md")).is_err());
        let plugin_file = roots.config.join("plugins/cache/p/agents/a.md");
        fs::create_dir_all(plugin_file.parent().unwrap()).unwrap();
        fs::write(&plugin_file, "plugin").unwrap();
        assert_eq!(read(&roots, &plugin_file).unwrap(), "plugin");
        assert!(write(&roots, &plugin_file, "x").is_err());
        assert!(delete(&roots, ItemKind::Agent, &plugin_file).is_err());
        let project = roots.project.clone().unwrap();
        fs::write(project.join("main.rs"), "code").unwrap();
        fs::write(project.join("CLAUDE.md"), "rules").unwrap();
        assert!(write(&roots, &project.join("main.rs"), "x").is_err(), "source files are not toolkit items");
        write(&roots, &project.join("CLAUDE.md"), "new rules").unwrap();
        let managed_file = roots.managed.join("CLAUDE.md");
        fs::create_dir_all(&roots.managed).unwrap();
        fs::write(&managed_file, "policy").unwrap();
        assert_eq!(read(&roots, &managed_file).unwrap(), "policy");
        assert!(write(&roots, &managed_file, "x").is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn copying_an_agent_to_another_scope_renames_it_in_frontmatter() {
        let (base, roots) = roots("copy");
        let source = create(&roots, ItemKind::Agent, ItemScope::Project, "reviewer", "---\nname: reviewer\ndescription: d\n---\nname: stays\n").unwrap();
        let target = copy(&roots, ItemKind::Agent, &source, ItemScope::User, "my-reviewer", false).unwrap();
        assert!(source.exists());
        assert_eq!(fs::read_to_string(&target).unwrap(), "---\nname: my-reviewer\ndescription: d\n---\nname: stays\n");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn moving_a_skill_takes_its_whole_folder() {
        let (base, roots) = roots("move");
        let source = create(&roots, ItemKind::Skill, ItemScope::User, "deploy", "steps").unwrap();
        fs::write(source.parent().unwrap().join("script.sh"), "echo hi").unwrap();
        let target = copy(&roots, ItemKind::Skill, &source, ItemScope::Project, "deploy", true).unwrap();
        assert!(!source.parent().unwrap().exists());
        assert_eq!(fs::read_to_string(&target).unwrap(), "steps");
        assert_eq!(fs::read_to_string(target.parent().unwrap().join("script.sh")).unwrap(), "echo hi");
        fs::remove_dir_all(base).unwrap();
    }
}
