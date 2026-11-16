use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

pub const CUCICODE_DIR: &str = "cucicode";

pub fn claude_config_dir() -> AppResult<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    dirs::home_dir()
        .map(|home| home.join(".claude"))
        .ok_or_else(|| AppError::Invalid("cannot determine the home directory".into()))
}

/// `.claude.json`: Claude Code's own state file, which also holds user- and local-scope MCP servers.
pub fn claude_user_state_file() -> AppResult<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(dir).join(".claude.json"));
    }
    dirs::home_dir()
        .map(|home| home.join(".claude.json"))
        .ok_or_else(|| AppError::Invalid("cannot determine the home directory".into()))
}

pub fn managed_settings_dir() -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(r"C:\Program Files\ClaudeCode")
    } else if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/ClaudeCode")
    } else {
        PathBuf::from("/etc/claude-code")
    }
}

pub fn encode_project_path(path: &Path) -> String {
    path.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_a_windows_path_the_way_claude_code_does() {
        assert_eq!(encode_project_path(Path::new(r"C:\WORK\CuciCode")), "C--WORK-CuciCode");
    }

    #[test]
    fn encodes_a_unix_path_with_dots_and_spaces() {
        assert_eq!(encode_project_path(Path::new("/home/me/my app.v2")), "-home-me-my-app-v2");
    }
}
