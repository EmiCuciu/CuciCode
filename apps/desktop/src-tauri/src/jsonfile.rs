use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use serde_json::Value;

use crate::error::{AppError, AppResult};

pub fn read_optional(path: &Path) -> AppResult<Option<Value>> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let text = text.trim_start_matches('\u{feff}');
    if text.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(text).map(Some).map_err(|source| AppError::Json {
        path: path.display().to_string(),
        source,
    })
}

pub fn write_atomic(path: &Path, value: &Value) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut text = serde_json::to_string_pretty(value).map_err(|source| AppError::Json {
        path: path.display().to_string(),
        source,
    })?;
    text.push('\n');
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, text)?;
    fs::rename(&temporary, path)?;
    Ok(())
}
