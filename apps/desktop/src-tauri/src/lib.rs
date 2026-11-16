mod error;
mod jsonfile;
mod paths;
mod projects;
mod settings;
mod sidecar;

use std::path::PathBuf;

use serde_json::Value;
use tauri::{Manager, State};

use error::{AppError, AppResult};
use projects::Project;
use settings::claude::ResolvedSetting;
use settings::cucicode::ProjectUiSettings;
use sidecar::Sidecar;

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
    sidecar.request(&method, params.unwrap_or(Value::Null)).await
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
async fn claude_settings_resolve(project_path: PathBuf) -> AppResult<Vec<ResolvedSetting>> {
    blocking(move || settings::claude::resolve_for_project(&project_path)).await
}

#[tauri::command]
async fn cucicode_project_ui_get(project_path: PathBuf) -> AppResult<ProjectUiSettings> {
    blocking(move || settings::cucicode::read_project_ui(&project_path)).await
}

#[tauri::command]
async fn cucicode_project_ui_set(project_path: PathBuf, settings: ProjectUiSettings) -> AppResult<()> {
    blocking(move || settings::cucicode::write_project_ui(&project_path, &settings)).await
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(Sidecar::new(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sidecar_request,
            projects_list,
            projects_add,
            projects_remove,
            claude_settings_resolve,
            cucicode_project_ui_get,
            cucicode_project_ui_set,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run CuciCode");
}
