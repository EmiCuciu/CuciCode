use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};

pub const OUTPUT_EVENT: &str = "pty://output";
pub const EXIT_EVENT: &str = "pty://exit";

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Invalid(message.into())
}

/// Splits a byte stream into valid UTF-8 text, keeping an incomplete trailing character for the next chunk.
#[derive(Default)]
pub struct Utf8Chunker {
    pending: Vec<u8>,
}

impl Utf8Chunker {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        match std::str::from_utf8(&self.pending) {
            Ok(text) => {
                let text = text.to_owned();
                self.pending.clear();
                text
            }
            Err(error) if error.error_len().is_none() => {
                let valid = error.valid_up_to();
                let text = String::from_utf8_lossy(&self.pending[..valid]).into_owned();
                self.pending.drain(..valid);
                text
            }
            Err(_) => String::from_utf8_lossy(&std::mem::take(&mut self.pending)).into_owned(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Exit {
    id: String,
    code: Option<u32>,
}

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// Interactive terminals: a real shell in a pseudo-terminal, streamed to the UI.
#[derive(Default)]
pub struct Terminals {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

fn default_shell() -> CommandBuilder {
    if cfg!(windows) {
        let mut command = CommandBuilder::new("powershell.exe");
        command.arg("-NoLogo");
        command
    } else {
        CommandBuilder::new_default_prog()
    }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }
}

impl Terminals {
    /// Starts a shell in `cwd`. When `command` is given it is typed into the shell once it starts.
    pub fn open(&self, app: AppHandle, id: &str, cwd: &Path, cols: u16, rows: u16, command: Option<&str>) -> AppResult<()> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(invalid("a terminal id may contain letters, digits, - and _"));
        }
        self.close(id);
        if !cwd.is_dir() {
            return Err(invalid(format!("{} is not a folder", cwd.display())));
        }
        let pair = native_pty_system().openpty(size(cols, rows)).map_err(|error| invalid(format!("cannot open a terminal: {error}")))?;
        let mut shell = default_shell();
        shell.cwd(cwd);
        shell.env("TERM", "xterm-256color");
        let child = pair.slave.spawn_command(shell).map_err(|error| invalid(format!("cannot start the shell: {error}")))?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|error| invalid(error.to_string()))?;
        let mut writer = pair.master.take_writer().map_err(|error| invalid(error.to_string()))?;
        if let Some(command) = command.map(str::trim).filter(|command| !command.is_empty()) {
            writer.write_all(format!("{command}\r").as_bytes())?;
        }
        self.sessions.lock().map_err(|_| invalid("terminal state is poisoned"))?.insert(id.to_owned(), Session { master: pair.master, writer, child });

        let sessions = Arc::clone(&self.sessions);
        let id = id.to_owned();
        std::thread::spawn(move || {
            let mut chunker = Utf8Chunker::default();
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        let data = chunker.push(&buffer[..read]);
                        if !data.is_empty() {
                            let _ = app.emit(OUTPUT_EVENT, Output { id: id.clone(), data });
                        }
                    }
                }
            }
            let code = sessions.lock().ok().and_then(|mut map| map.remove(&id)).and_then(|mut session| session.child.wait().ok()).map(|status| status.exit_code());
            let _ = app.emit(EXIT_EVENT, Exit { id, code });
        });
        Ok(())
    }

    pub fn write(&self, id: &str, data: &str) -> AppResult<()> {
        let mut sessions = self.sessions.lock().map_err(|_| invalid("terminal state is poisoned"))?;
        let session = sessions.get_mut(id).ok_or_else(|| invalid("the terminal is closed"))?;
        session.writer.write_all(data.as_bytes())?;
        session.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> AppResult<()> {
        let sessions = self.sessions.lock().map_err(|_| invalid("terminal state is poisoned"))?;
        if let Some(session) = sessions.get(id) {
            session.master.resize(size(cols, rows)).map_err(|error| invalid(error.to_string()))?;
        }
        Ok(())
    }

    pub fn close(&self, id: &str) {
        let removed = self.sessions.lock().ok().and_then(|mut map| map.remove(id));
        if let Some(mut session) = removed {
            let _ = session.child.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_split_multibyte_character_for_the_next_chunk() {
        let mut chunker = Utf8Chunker::default();
        let bytes = "é✓".as_bytes();
        assert_eq!(chunker.push(&bytes[..1]), "");
        assert_eq!(chunker.push(&bytes[1..3]), "é");
        assert_eq!(chunker.push(&bytes[3..]), "✓");
        assert_eq!(chunker.push(b"plain"), "plain");
    }

    #[test]
    fn runs_a_command_in_a_real_pseudo_terminal_and_reads_its_output() {
        let pair = native_pty_system().openpty(size(80, 24)).expect("open a pseudo-terminal");
        let mut command = default_shell();
        if cfg!(windows) {
            command.args(["-NoProfile", "-Command", "Write-Output ('pty' + '-ok')"]);
        } else {
            command.args(["-c", "echo pty-ok"]);
        }
        let mut child = pair.slave.spawn_command(command).expect("start the shell");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut writer = pair.master.take_writer().expect("writer");
        let (sender, receiver) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            let mut chunker = Utf8Chunker::default();
            let mut buffer = [0u8; 4096];
            while let Ok(read) = reader.read(&mut buffer) {
                if read == 0 || sender.send(chunker.push(&buffer[..read])).is_err() {
                    break;
                }
            }
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut output = String::new();
        while !output.contains("pty-ok") {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let Ok(chunk) = receiver.recv_timeout(remaining) else { break };
            // A terminal must answer a cursor position query; xterm.js does this in the app.
            if chunk.contains("\x1b[6n") {
                writer.write_all(b"\x1b[1;1R").expect("answer the cursor query");
            }
            output.push_str(&chunk);
        }
        let _ = child.kill();
        assert!(output.contains("pty-ok"), "unexpected terminal output: {output:?}");
    }

    #[test]
    fn replaces_invalid_bytes_instead_of_stalling() {
        let mut chunker = Utf8Chunker::default();
        assert_eq!(chunker.push(&[b'a', 0xff, b'b']), "a\u{fffd}b");
        assert_eq!(chunker.push(b"c"), "c");
    }
}
