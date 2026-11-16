use std::collections::HashMap;

use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::settings::cucicode::{load_document, save_document, user_settings_path};

const SERVICE: &str = "cucicode";
const NAMES_KEY: &str = "secretNames";

/// A secret is referenced from config files as `${NAME}`, so its name must be a valid environment variable name.
pub fn check_name(name: &str) -> AppResult<()> {
    let mut chars = name.chars();
    let valid = chars.next().is_some_and(|first| first.is_ascii_uppercase() || first == '_') && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    valid.then_some(()).ok_or_else(|| AppError::Invalid(format!("\"{name}\" is not a valid secret name: use capitals, digits and _, e.g. GITHUB_TOKEN")))
}

fn keychain(name: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, name).map_err(|error| AppError::Invalid(format!("cannot open the OS keychain: {error}")))
}

/// Names only. The values stay in the OS keychain and are never written to a file.
pub fn names() -> AppResult<Vec<String>> {
    let document = load_document(&user_settings_path()?)?;
    Ok(document.get(NAMES_KEY).and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default())
}

fn save_names(names: &[String]) -> AppResult<()> {
    let path = user_settings_path()?;
    let mut document = load_document(&path)?;
    document.insert(NAMES_KEY.into(), json!(names));
    save_document(&path, document)
}

pub fn set(name: &str, value: &str) -> AppResult<()> {
    check_name(name)?;
    if value.is_empty() {
        return Err(AppError::Invalid("the secret value is empty".into()));
    }
    keychain(name)?.set_password(value).map_err(|error| AppError::Invalid(format!("cannot store the secret in the OS keychain: {error}")))?;
    let mut all = names()?;
    if !all.iter().any(|existing| existing == name) {
        all.push(name.to_owned());
        all.sort();
        save_names(&all)?;
    }
    Ok(())
}

pub fn delete(name: &str) -> AppResult<()> {
    check_name(name)?;
    match keychain(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(error) => return Err(AppError::Invalid(format!("cannot delete the secret from the OS keychain: {error}"))),
    }
    let remaining: Vec<String> = names()?.into_iter().filter(|existing| existing != name).collect();
    save_names(&remaining)
}

/// Every stored secret, for the environment of sessions CuciCode starts.
pub fn environment() -> HashMap<String, String> {
    names()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|name| {
            let value = keychain(&name).ok()?.get_password().ok()?;
            Some((name, value))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_environment_variable_style_names_only() {
        for name in ["GITHUB_TOKEN", "_X", "A1"] {
            assert!(check_name(name).is_ok(), "{name}");
        }
        for name in ["", "github_token", "1A", "A-B", "A B", "A$B"] {
            assert!(check_name(name).is_err(), "{name:?}");
        }
    }
}
