use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};

pub const CHANGED_EVENT: &str = "toolkit://changed";
const QUIET_PERIOD: Duration = Duration::from_millis(400);
const ITEM_FOLDERS: &[&str] = &["agents", "skills", "commands", "output-styles", "rules"];
const WATCHED_FILES: &[&str] = &["settings.json", "settings.local.json", "claude.md", "claude.local.md", ".mcp.json", "installed_plugins.json", "known_marketplaces.json"];

/// Whether a changed path can affect what the Toolkit shows. Transcripts and
/// other session state under `~/.claude` change constantly and are ignored.
pub fn is_relevant(path: &Path) -> bool {
    let text = path.to_string_lossy().replace('\\', "/").to_lowercase();
    let file = text.rsplit('/').next().unwrap_or_default();
    if WATCHED_FILES.contains(&file) {
        return true;
    }
    ITEM_FOLDERS.iter().any(|folder| text.contains(&format!("/{folder}/")) || text.ends_with(&format!("/{folder}")))
}

/// The directories to watch: `(path, recursive)`. Only item folders are watched
/// recursively, so the large `projects` folder of transcripts is never walked.
pub fn targets(config: &Path, project: Option<&Path>) -> Vec<(PathBuf, bool)> {
    let mut targets = vec![(config.to_path_buf(), false), (config.join("plugins"), false)];
    targets.extend(ITEM_FOLDERS.iter().map(|folder| (config.join(folder), true)));
    if let Some(project) = project {
        targets.push((project.to_path_buf(), false));
        targets.push((project.join(".claude"), true));
    }
    targets.into_iter().filter(|(path, _)| path.is_dir()).collect()
}

/// Holds the active file watcher; replacing it stops the previous one.
#[derive(Default)]
pub struct ToolkitWatcher {
    current: Mutex<Option<RecommendedWatcher>>,
}

impl ToolkitWatcher {
    pub fn watch(&self, app: AppHandle, config: &Path, project: Option<&Path>) -> AppResult<()> {
        let (sender, receiver) = mpsc::channel::<()>();
        let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            if let Ok(event) = result {
                if !event.kind.is_access() && event.paths.iter().any(|path| is_relevant(path)) {
                    let _ = sender.send(());
                }
            }
        })
        .map_err(|error| AppError::Invalid(format!("cannot watch files: {error}")))?;
        for (path, recursive) in targets(config, project) {
            let mode = if recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive };
            if let Err(error) = watcher.watch(&path, mode) {
                eprintln!("[toolkit] cannot watch {}: {error}", path.display());
            }
        }
        std::thread::spawn(move || {
            while receiver.recv().is_ok() {
                while receiver.recv_timeout(QUIET_PERIOD).is_ok() {}
                let _ = app.emit(CHANGED_EVENT, ());
            }
        });
        *self.current.lock().map_err(|_| AppError::Invalid("watcher state is poisoned".into()))? = Some(watcher);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn item_files_and_settings_are_relevant() {
        for path in [
            r"C:\Users\me\.claude\agents\reviewer.md",
            r"C:\Users\me\.claude\skills\deploy\SKILL.md",
            r"C:\Users\me\.claude\skills\deploy",
            "/home/me/.claude/settings.json",
            "/work/app/.claude/settings.local.json",
            "/work/app/CLAUDE.md",
            "/work/app/.mcp.json",
            "/home/me/.claude/plugins/installed_plugins.json",
        ] {
            assert!(is_relevant(Path::new(path)), "{path} should trigger a rescan");
        }
    }

    #[test]
    fn transcripts_source_files_and_other_state_are_ignored() {
        for path in [
            r"C:\Users\me\.claude\projects\C--work-app\abc.jsonl",
            "/home/me/.claude/history.jsonl",
            "/home/me/.claude/.credentials.json",
            "/work/app/src/main.rs",
            "/work/app/package.json",
            "/home/me/.claude/cucicode/settings.local.json.tmp",
        ] {
            assert!(!is_relevant(Path::new(path)), "{path} should be ignored");
        }
    }

    #[test]
    fn only_existing_folders_are_watched_and_only_item_folders_recursively() {
        let base = std::env::temp_dir().join(format!("cucicode-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let config = base.join(".claude");
        let project = base.join("project");
        std::fs::create_dir_all(config.join("skills")).unwrap();
        std::fs::create_dir_all(config.join("projects")).unwrap();
        std::fs::create_dir_all(project.join(".claude")).unwrap();
        let found = targets(&config, Some(&project));
        std::fs::remove_dir_all(&base).unwrap();
        assert_eq!(found, vec![(config.clone(), false), (config.join("skills"), true), (project.clone(), false), (project.join(".claude"), true)]);
    }
}
