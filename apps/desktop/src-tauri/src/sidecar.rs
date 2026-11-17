use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as SyncMutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

use crate::error::{AppError, AppResult};

pub const SIDECAR_EVENT: &str = "sidecar://event";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);
const DEFAULT_SCRIPT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../sidecar/dist/sidecar.mjs");

const VERBATIM_PREFIX: &str = r"\\?\";
const BUNDLED_SCRIPT: &str = "sidecar/sidecar.mjs";
const BUNDLED_NODE: &str = if cfg!(windows) { "node.exe" } else { "node" };

type Reply = Result<Value, String>;

#[derive(Default)]
struct Shared {
    stdin: Mutex<Option<ChildStdin>>,
    pending: SyncMutex<HashMap<String, oneshot::Sender<Reply>>>,
    next_id: AtomicU64,
}

impl Shared {
    fn take_pending(&self, id: &str) -> Option<oneshot::Sender<Reply>> {
        self.pending.lock().ok()?.remove(id)
    }

    fn fail_all(&self, reason: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err(reason.to_owned()));
            }
        }
    }
}

/// Owns the Node sidecar process: starts it on first use, matches responses to
/// requests by id, and forwards timeline events to the UI.
pub struct Sidecar {
    app: AppHandle,
    shared: Arc<Shared>,
}

fn handle_line(app: &AppHandle, shared: &Shared, line: &str) {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        eprintln!("[sidecar] unparseable line: {line}");
        return;
    };
    match message.get("type").and_then(Value::as_str) {
        Some("response") => {
            let id = message.get("id").and_then(Value::as_str).unwrap_or_default();
            if let Some(sender) = shared.take_pending(id) {
                let reply = if message.get("ok").and_then(Value::as_bool) == Some(true) {
                    Ok(message.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    Err(message.get("error").and_then(Value::as_str).unwrap_or("unknown sidecar error").to_owned())
                };
                let _ = sender.send(reply);
            }
        }
        Some("event") => {
            let payload = json!({ "chatId": message.get("chatId"), "event": message.get("event") });
            if let Err(error) = app.emit(SIDECAR_EVENT, payload) {
                eprintln!("[sidecar] failed to forward event: {error}");
            }
        }
        Some("ready") => eprintln!("[sidecar] ready: {line}"),
        Some("log") => eprintln!("[sidecar] {}", message.get("message").and_then(Value::as_str).unwrap_or_default()),
        _ => eprintln!("[sidecar] unknown message: {line}"),
    }
}

impl Sidecar {
    pub fn new(app: AppHandle) -> Self {
        Self { app, shared: Arc::new(Shared::default()) }
    }

    fn script_path(&self) -> PathBuf {
        if let Some(path) = std::env::var_os("CUCICODE_SIDECAR") {
            return PathBuf::from(path);
        }
        self.app
            .path()
            .resource_dir()
            .map(|dir| PathBuf::from(dir.join(BUNDLED_SCRIPT).to_string_lossy().trim_start_matches(VERBATIM_PREFIX)))
            .ok()
            .filter(|path| path.is_file())
            .unwrap_or_else(|| PathBuf::from(DEFAULT_SCRIPT))
    }

    fn node_program() -> std::ffi::OsString {
        if let Some(node) = std::env::var_os("CUCICODE_NODE") {
            return node;
        }
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join(BUNDLED_NODE)))
            .filter(|path| path.is_file())
            .map_or_else(|| "node".into(), PathBuf::into_os_string)
    }

    fn spawn(&self) -> AppResult<ChildStdin> {
        let script = self.script_path();
        if !script.is_file() {
            return Err(AppError::Sidecar(format!(
                "{} not found; run \"npm run build:sidecar\" in the repository root",
                script.display()
            )));
        }
        let mut command = Command::new(Self::node_program());
        command.env_clear().envs(crate::system_env::current());
        command
            .arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|error| AppError::Sidecar(format!("cannot start node: {error}")))?;
        let stdin = child.stdin.take().ok_or_else(|| AppError::Sidecar("sidecar has no stdin".into()))?;
        let stdout = child.stdout.take().ok_or_else(|| AppError::Sidecar("sidecar has no stdout".into()))?;

        if let Some(stderr) = child.stderr.take() {
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[sidecar] {line}");
                }
            });
        }

        let app = self.app.clone();
        let shared = Arc::clone(&self.shared);
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                handle_line(&app, &shared, &line);
            }
            let status = child.wait().await;
            eprintln!("[sidecar] exited: {status:?}");
            *shared.stdin.lock().await = None;
            shared.fail_all("the sidecar process exited");
        });
        Ok(stdin)
    }

    pub async fn request(&self, method: &str, params: Value) -> AppResult<Value> {
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed).to_string();
        let (sender, receiver) = oneshot::channel();
        let line = format!("{}\n", json!({ "id": id, "method": method, "params": params }));
        {
            let mut stdin = self.shared.stdin.lock().await;
            if stdin.is_none() {
                *stdin = Some(self.spawn()?);
            }
            self.shared
                .pending
                .lock()
                .map_err(|_| AppError::Sidecar("request table is poisoned".into()))?
                .insert(id.clone(), sender);
            let pipe = stdin.as_mut().ok_or_else(|| AppError::Sidecar("sidecar is not running".into()))?;
            if let Err(error) = pipe.write_all(line.as_bytes()).await {
                *stdin = None;
                self.shared.take_pending(&id);
                return Err(AppError::Sidecar(format!("cannot write to the sidecar: {error}")));
            }
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(message))) => Err(AppError::Sidecar(message)),
            Ok(Err(_)) => Err(AppError::Sidecar("the sidecar dropped the request".into())),
            Err(_) => {
                self.shared.take_pending(&id);
                Err(AppError::Sidecar(format!("{method} timed out after {}s", REQUEST_TIMEOUT.as_secs())))
            }
        }
    }
}
