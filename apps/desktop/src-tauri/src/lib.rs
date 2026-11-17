mod checks;
mod claude_cli;
mod error;
mod git_host;
mod git_ops;
mod jsonfile;
mod paths;
mod projects;
mod secrets;
mod settings;
mod sidecar;
mod stories;
mod toolkit;
mod usage;
mod voice;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use voice::{Voice, VoiceStatus};

use claude_cli::{CliScope, PluginAction};
use error::{AppError, AppResult};
use projects::Project;
use settings::claude::{ResolvedSetting, Scope, ScopeFile, SettingsLocations};
use settings::cucicode::{ProjectSettings, ProjectUiSettings};
use stories::{FolderTarget, StoriesTarget, Story};
use sidecar::Sidecar;
use toolkit::model::{ItemKind, ItemScope};

async fn blocking<T, F>(work: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| AppError::Invalid(format!("background task failed: {error}")))?
}

#[tauri::command]
async fn sidecar_request(sidecar: State<'_, Sidecar>, method: String, params: Option<Value>) -> AppResult<Value> {
    let mut params = params.unwrap_or(Value::Null);
    if method == "chat.open" {
        if let Some(object) = params.as_object_mut() {
            let secrets = blocking(|| Ok(secrets::environment())).await?;
            object.insert("env".into(), serde_json::json!(secrets));
        }
    }
    sidecar.request(&method, params).await
}

#[tauri::command]
async fn projects_list() -> AppResult<Vec<Project>> {
    blocking(projects::list).await
}

#[tauri::command]
async fn projects_add(path: PathBuf) -> AppResult<Project> {
    blocking(move || projects::add(&path)).await
}

#[tauri::command]
async fn projects_remove(id: String) -> AppResult<()> {
    blocking(move || projects::remove(&id)).await
}

#[tauri::command]
async fn claude_settings_resolve(project_path: Option<PathBuf>) -> AppResult<Vec<ResolvedSetting>> {
    blocking(move || settings::claude::resolve_for_project(project_path.as_deref())).await
}

#[tauri::command]
async fn claude_settings_files(project_path: Option<PathBuf>) -> AppResult<Vec<ScopeFile>> {
    blocking(move || settings::claude::scope_files(&SettingsLocations::system()?, project_path.as_deref())).await
}

#[tauri::command]
async fn claude_settings_set(scope: Scope, project_path: Option<PathBuf>, key: String, value: Option<Value>) -> AppResult<()> {
    blocking(move || settings::claude::set_value(&SettingsLocations::system()?, scope, project_path.as_deref(), &key, value)).await
}

#[tauri::command]
async fn cucicode_project_ui_get(project_path: PathBuf) -> AppResult<ProjectUiSettings> {
    blocking(move || settings::cucicode::read_project_ui(&project_path)).await
}

#[tauri::command]
async fn cucicode_project_ui_set(project_path: PathBuf, settings: ProjectUiSettings) -> AppResult<()> {
    blocking(move || settings::cucicode::write_project_ui(&project_path, &settings)).await
}

fn stories_target(project: &std::path::Path) -> AppResult<FolderTarget> {
    let settings = settings::cucicode::read_project_settings(project)?;
    let folder = settings::cucicode::effective_setting(&settings, &["stories", "folder"]);
    FolderTarget::new(project, folder.as_ref().and_then(Value::as_str))
}

#[tauri::command]
async fn cucicode_settings_get(project_path: PathBuf) -> AppResult<ProjectSettings> {
    blocking(move || settings::cucicode::read_project_settings(&project_path)).await
}

#[tauri::command]
async fn cucicode_settings_set(project_path: PathBuf, local: bool, key: String, value: Option<Value>) -> AppResult<()> {
    blocking(move || settings::cucicode::set_project_setting(&project_path, local, &key, value)).await
}

#[tauri::command]
async fn pipeline_state_get(project_path: PathBuf) -> AppResult<Value> {
    blocking(move || settings::cucicode::read_pipeline_state(&project_path)).await
}

#[tauri::command]
async fn pipeline_state_set(project_path: PathBuf, state: Value) -> AppResult<()> {
    blocking(move || settings::cucicode::write_pipeline_state(&project_path, state)).await
}

#[tauri::command]
async fn stories_list(project_path: PathBuf) -> AppResult<Vec<Story>> {
    blocking(move || stories_target(&project_path)?.list()).await
}

#[tauri::command]
async fn story_set_field(project_path: PathBuf, story_id: String, key: String, value: Option<String>) -> AppResult<()> {
    blocking(move || stories_target(&project_path)?.set_field(&story_id, &key, value.as_deref())).await
}

#[tauri::command]
async fn story_archive(project_path: PathBuf, story_id: String) -> AppResult<PathBuf> {
    blocking(move || stories_target(&project_path)?.archive(&story_id)).await
}

#[tauri::command]
async fn worktree_list(project_path: PathBuf) -> AppResult<Vec<git_ops::Worktree>> {
    blocking(move || git_ops::worktree_list(&project_path)).await
}

#[tauri::command]
async fn worktree_add(project_path: PathBuf, story_id: String) -> AppResult<git_ops::Worktree> {
    blocking(move || git_ops::worktree_add(&project_path, &story_id)).await
}

#[tauri::command]
async fn worktree_remove(project_path: PathBuf, story_id: String, delete_branch: bool) -> AppResult<()> {
    blocking(move || git_ops::worktree_remove(&project_path, &story_id, delete_branch)).await
}

#[tauri::command]
async fn worktree_commit(project_path: PathBuf, story_id: String, message: String) -> AppResult<bool> {
    blocking(move || git_ops::commit_worktree(&project_path, &story_id, &message)).await
}

#[tauri::command]
async fn story_commits(project_path: PathBuf, story_id: String) -> AppResult<Vec<git_ops::StoryCommit>> {
    blocking(move || git_ops::story_commits(&project_path, &story_id)).await
}

#[tauri::command]
async fn story_reset(project_path: PathBuf, story_id: String, sha: String) -> AppResult<()> {
    blocking(move || git_ops::story_reset(&project_path, &story_id, &sha)).await
}

#[tauri::command]
async fn story_diff(project_path: PathBuf, story_id: String) -> AppResult<git_ops::StoryDiff> {
    blocking(move || git_ops::story_diff(&project_path, &story_id)).await
}

#[tauri::command]
async fn story_merge(project_path: PathBuf, story_id: String) -> AppResult<String> {
    blocking(move || git_ops::merge_story(&project_path, &story_id)).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FinishedStory {
    commit: String,
    archived: bool,
    pushed: bool,
    warnings: Vec<String>,
}

/// Merges a story, archives its file, removes its worktree and optionally pushes.
/// Only the merge can fail the whole operation; later steps are reported as warnings.
#[tauri::command]
async fn story_finish(project_path: PathBuf, story_id: String, push: bool) -> AppResult<FinishedStory> {
    blocking(move || {
        let commit = git_ops::merge_story(&project_path, &story_id)?;
        let mut warnings = Vec::new();
        let target = stories_target(&project_path)?;
        let archived = match target.archive(&story_id) {
            Ok(_) => {
                let folder = target.folder_name();
                match git_ops::commit_folder(&project_path, &folder, &format!("{story_id}: archive story")) {
                    Ok(_) => true,
                    Err(error) => {
                        warnings.push(format!("the story was archived but not committed: {error}"));
                        true
                    }
                }
            }
            Err(error) => {
                warnings.push(format!("the story file was not archived: {error}"));
                false
            }
        };
        if let Err(error) = git_ops::worktree_remove(&project_path, &story_id, true) {
            warnings.push(format!("the worktree was not removed: {error}"));
        }
        let pushed = push
            && match git_ops::push(&project_path) {
                Ok(_) => true,
                Err(error) => {
                    warnings.push(format!("not pushed: {error}"));
                    false
                }
            };
        Ok(FinishedStory { commit, archived, pushed, warnings })
    })
    .await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitHostInfo {
    remote: Option<git_host::Remote>,
    token_name: Option<&'static str>,
    has_token: bool,
}

/// Which host the project's origin points at and whether a token for it is stored.
#[tauri::command]
async fn git_host_info(project_path: PathBuf) -> AppResult<GitHostInfo> {
    blocking(move || {
        let remote = git_host::origin(&project_path).ok();
        let token_name = remote.as_ref().and_then(|remote| match remote.kind {
            git_host::HostKind::GitHub => Some(git_host::GITHUB_TOKEN),
            git_host::HostKind::Bitbucket => Some(git_host::BITBUCKET_TOKEN),
            git_host::HostKind::Other => None,
        });
        let has_token = token_name.is_some_and(|name| secrets::names().unwrap_or_default().iter().any(|stored| stored == name));
        Ok(GitHostInfo { remote, token_name, has_token })
    })
    .await
}

/// Pushes a story's branch, opens a pull request for it and removes the local worktree.
#[tauri::command]
async fn story_pull_request(project_path: PathBuf, story_id: String) -> AppResult<git_host::OpenedPullRequest> {
    blocking(move || {
        let story = stories_target(&project_path)?.find(&story_id).ok();
        let title = story.as_ref().map_or_else(|| story_id.clone(), |story| format!("{}: {}", story.id, story.title));
        let criteria = story.as_ref().map(|story| story.acceptance_criteria.iter().map(|item| format!("- {item}")).collect::<Vec<_>>().join("\n")).unwrap_or_default();
        let description = format!("Story {story_id}, built and reviewed with the CuciCode pipeline.\n\n## Acceptance criteria\n\n{criteria}\n");
        let opened = git_host::open_pull_request(&project_path, &story_id, &title, &description)?;
        if let Err(error) = git_ops::worktree_remove(&project_path, &story_id, false) {
            eprintln!("[git] worktree for {story_id} was not removed: {error}");
        }
        Ok(opened)
    })
    .await
}

/// Commits the plan and story files so that worktrees, which start from the last commit, contain them.
#[tauri::command]
async fn pipeline_commit_docs(project_path: PathBuf, message: String) -> AppResult<bool> {
    blocking(move || {
        let stories = stories_target(&project_path)?.folder_name();
        let mut committed = false;
        for folder in ["Plans", stories.as_str()] {
            if project_path.join(folder).is_dir() {
                committed |= git_ops::commit_folder(&project_path, folder, &message)?;
            }
        }
        Ok(committed)
    })
    .await
}

/// Where the CuciCode plugin marketplace lives, so the app can offer to install it.
#[tauri::command]
fn plugin_source() -> String {
    std::env::var("CUCICODE_PLUGIN_SOURCE").unwrap_or_else(|_| {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..");
        root.canonicalize().unwrap_or(root).display().to_string().trim_start_matches(r"\\?\").to_owned()
    })
}

fn check_commands(project: &std::path::Path) -> AppResult<Vec<String>> {
    let settings = settings::cucicode::read_project_settings(project)?;
    let configured: Vec<String> = settings::cucicode::effective_setting(&settings, &["checks", "commands"])
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|command| command.as_str().map(str::trim).filter(|command| !command.is_empty()).map(str::to_owned))
        .collect();
    Ok(if configured.is_empty() { checks::detect(project) } else { configured })
}

#[tauri::command]
async fn checks_commands(project_path: PathBuf) -> AppResult<Vec<String>> {
    blocking(move || check_commands(&project_path)).await
}

/// Runs the project's checks in a story's worktree, or in the project itself when no story is given.
#[tauri::command]
async fn checks_run(project_path: PathBuf, story_id: Option<String>) -> AppResult<checks::CheckRun> {
    let project = project_path.clone();
    let commands = blocking(move || check_commands(&project)).await?;
    let dir = match &story_id {
        Some(id) => {
            git_ops::check_story_id(id)?;
            let worktree = git_ops::worktree_path(&project_path, id);
            if !worktree.is_dir() {
                return Err(AppError::Invalid(format!("there is no worktree for {id}")));
            }
            worktree
        }
        None => project_path,
    };
    checks::run(&dir, &commands).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageReport {
    limits: Option<usage::ReportedLimits>,
    rows: Vec<usage::UsageRow>,
}

/// Reported window figures plus token usage counted from transcripts since a point in time.
#[tauri::command]
async fn usage_report(since_ms: u64) -> AppResult<UsageReport> {
    blocking(move || {
        let limits = usage::reported_limits(&paths::claude_user_state_file()?)?;
        let rows = usage::scan(&paths::claude_config_dir()?.join("projects"), since_ms);
        Ok(UsageReport { limits, rows })
    })
    .await
}

#[tauri::command]
async fn usage_limits() -> AppResult<Option<usage::ReportedLimits>> {
    blocking(|| usage::reported_limits(&paths::claude_user_state_file()?)).await
}

#[tauri::command]
async fn toolkit_scan(project_path: Option<PathBuf>) -> AppResult<toolkit::model::ToolkitScan> {
    blocking(move || toolkit::scan(project_path.as_deref())).await
}

#[tauri::command]
async fn mcp_health(project_path: Option<PathBuf>) -> AppResult<Vec<claude_cli::McpHealth>> {
    blocking(move || claude_cli::mcp_health(project_path.as_deref())).await
}

#[tauri::command]
async fn mcp_add(scope: CliScope, name: String, config: Value, project_path: Option<PathBuf>) -> AppResult<()> {
    blocking(move || claude_cli::mcp_add(scope, &name, &config, project_path.as_deref())).await
}

#[tauri::command]
async fn mcp_remove(scope: CliScope, name: String, project_path: Option<PathBuf>) -> AppResult<()> {
    blocking(move || claude_cli::mcp_remove(scope, &name, project_path.as_deref())).await
}

#[tauri::command]
async fn plugin_action(action: PluginAction, plugin: String, scope: CliScope, project_path: Option<PathBuf>) -> AppResult<String> {
    blocking(move || claude_cli::plugin(action, &plugin, scope, project_path.as_deref())).await
}

#[tauri::command]
async fn marketplace_add(source: String, scope: CliScope, project_path: Option<PathBuf>) -> AppResult<String> {
    blocking(move || claude_cli::marketplace_add(&source, scope, project_path.as_deref())).await
}

#[tauri::command]
async fn marketplace_update(name: String) -> AppResult<String> {
    blocking(move || claude_cli::marketplace_update(&name)).await
}

#[tauri::command]
async fn marketplace_remove(name: String) -> AppResult<String> {
    blocking(move || claude_cli::marketplace_remove(&name)).await
}

#[tauri::command]
async fn secrets_names() -> AppResult<Vec<String>> {
    blocking(secrets::names).await
}

#[tauri::command]
async fn secrets_set(name: String, value: String) -> AppResult<()> {
    blocking(move || secrets::set(&name, &value)).await
}

#[tauri::command]
async fn secrets_delete(name: String) -> AppResult<()> {
    blocking(move || secrets::delete(&name)).await
}

#[tauri::command]
fn toolkit_watch(app: AppHandle, watcher: State<'_, toolkit::watch::ToolkitWatcher>, project_path: Option<PathBuf>) -> AppResult<()> {
    let config = SettingsLocations::system()?.config_dir;
    watcher.watch(app, &config, project_path.as_deref())
}

#[tauri::command]
async fn toolkit_read(path: PathBuf, project_path: Option<PathBuf>) -> AppResult<String> {
    blocking(move || toolkit::edit::read(&toolkit::system_roots(project_path)?, &path)).await
}

#[tauri::command]
async fn toolkit_write(path: PathBuf, content: String, project_path: Option<PathBuf>) -> AppResult<()> {
    blocking(move || toolkit::edit::write(&toolkit::system_roots(project_path)?, &path, &content)).await
}

#[tauri::command]
async fn toolkit_create(kind: ItemKind, scope: ItemScope, name: String, content: String, project_path: Option<PathBuf>) -> AppResult<PathBuf> {
    blocking(move || toolkit::edit::create(&toolkit::system_roots(project_path)?, kind, scope, &name, &content)).await
}

#[tauri::command]
async fn toolkit_delete(kind: ItemKind, path: PathBuf, project_path: Option<PathBuf>) -> AppResult<()> {
    blocking(move || toolkit::edit::delete(&toolkit::system_roots(project_path)?, kind, &path)).await
}

#[tauri::command]
async fn toolkit_copy(kind: ItemKind, path: PathBuf, target_scope: ItemScope, new_name: String, remove_source: bool, project_path: Option<PathBuf>) -> AppResult<PathBuf> {
    blocking(move || toolkit::edit::copy(&toolkit::system_roots(project_path)?, kind, &path, target_scope, &new_name, remove_source)).await
}

#[tauri::command]
fn toolkit_validate(kind: ItemKind, content: String) -> Vec<toolkit::validate::Problem> {
    toolkit::validate::validate(kind, &content)
}

#[tauri::command]
fn voice_status(voice: State<'_, Arc<Voice>>) -> VoiceStatus {
    voice.status()
}

#[tauri::command]
async fn voice_download_model(app: AppHandle, voice: State<'_, Arc<Voice>>) -> AppResult<()> {
    let voice = Arc::clone(&voice);
    blocking(move || voice.download_model(&app)).await
}

#[tauri::command]
async fn voice_start(voice: State<'_, Arc<Voice>>) -> AppResult<()> {
    let voice = Arc::clone(&voice);
    blocking(move || voice.start()).await
}

#[tauri::command]
async fn voice_stop(voice: State<'_, Arc<Voice>>) -> AppResult<String> {
    let voice = Arc::clone(&voice);
    blocking(move || voice.stop_and_transcribe()).await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            app.manage(Sidecar::new(app.handle().clone()));
            app.manage(toolkit::watch::ToolkitWatcher::default());
            let models = app.path().app_data_dir()?.join("models");
            app.manage(Arc::new(Voice::new(models)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar_request,
            projects_list,
            projects_add,
            projects_remove,
            claude_settings_resolve,
            claude_settings_files,
            claude_settings_set,
            cucicode_project_ui_get,
            cucicode_project_ui_set,
            cucicode_settings_get,
            cucicode_settings_set,
            pipeline_state_get,
            pipeline_state_set,
            stories_list,
            story_set_field,
            story_archive,
            worktree_list,
            worktree_add,
            worktree_remove,
            worktree_commit,
            story_commits,
            story_reset,
            story_diff,
            story_merge,
            story_finish,
            story_pull_request,
            git_host_info,
            pipeline_commit_docs,
            plugin_source,
            checks_commands,
            checks_run,
            usage_report,
            usage_limits,
            toolkit_scan,
            toolkit_watch,
            mcp_health,
            mcp_add,
            mcp_remove,
            plugin_action,
            marketplace_add,
            marketplace_update,
            marketplace_remove,
            secrets_names,
            secrets_set,
            secrets_delete,
            toolkit_read,
            toolkit_write,
            toolkit_create,
            toolkit_delete,
            toolkit_copy,
            toolkit_validate,
            voice_status,
            voice_download_model,
            voice_start,
            voice_stop,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run CuciCode");
}
