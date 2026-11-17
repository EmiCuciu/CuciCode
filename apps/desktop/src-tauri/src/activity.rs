use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Lines kept when the log is trimmed; the file is cut back once it is twice this long.
const KEEP: usize = 2000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub ts: u64,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub kind: String,
    pub text: String,
    #[serde(default)]
    pub needs_user: bool,
}

/// Appends one entry. The log is CuciCode's own record; Claude Code never reads it.
pub fn append(file: &Path, entry: &ActivityEntry) -> AppResult<()> {
    if entry.text.trim().is_empty() || entry.kind.trim().is_empty() {
        return Err(AppError::Invalid("an activity entry needs a kind and a text".into()));
    }
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    let line = serde_json::to_string(entry).map_err(|error| AppError::Invalid(error.to_string()))?;
    let mut handle = OpenOptions::new().create(true).append(true).open(file)?;
    writeln!(handle, "{line}")?;
    drop(handle);
    trim(file)
}

fn trim(file: &Path) -> AppResult<()> {
    let content = fs::read_to_string(file)?;
    let lines: Vec<&str> = content.lines().collect();
    if lines.len() <= KEEP * 2 {
        return Ok(());
    }
    let kept = lines[lines.len() - KEEP..].join("\n");
    let temporary = file.with_extension("jsonl.tmp");
    fs::write(&temporary, format!("{kept}\n"))?;
    fs::rename(&temporary, file)?;
    Ok(())
}

/// The newest entries first. Lines that do not parse are skipped.
pub fn list(file: &Path, limit: usize) -> AppResult<Vec<ActivityEntry>> {
    let content = match fs::read_to_string(file) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    Ok(content.lines().rev().filter_map(|line| serde_json::from_str(line).ok()).take(limit).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(ts: u64, text: &str) -> ActivityEntry {
        ActivityEntry { ts, project_id: Some("p".into()), project_name: Some("App".into()), kind: "stage".into(), text: text.into(), needs_user: false }
    }

    #[test]
    fn appends_and_lists_newest_first_skipping_bad_lines() {
        let file = std::env::temp_dir().join(format!("cucicode-activity-{}.jsonl", std::process::id()));
        let _ = fs::remove_file(&file);
        assert!(list(&file, 10).unwrap().is_empty());
        append(&file, &entry(1, "first")).unwrap();
        fs::write(&file, format!("{}not json\n", fs::read_to_string(&file).unwrap())).unwrap();
        append(&file, &entry(2, "second")).unwrap();
        let listed = list(&file, 10).unwrap();
        assert_eq!(listed.iter().map(|item| item.text.as_str()).collect::<Vec<_>>(), vec!["second", "first"]);
        assert_eq!(list(&file, 1).unwrap().len(), 1);
        assert!(append(&file, &entry(3, "  ")).is_err());
        fs::remove_file(&file).unwrap();
    }

    #[test]
    fn trims_the_file_once_it_grows_past_twice_the_limit() {
        let file = std::env::temp_dir().join(format!("cucicode-activity-trim-{}.jsonl", std::process::id()));
        let line = serde_json::to_string(&entry(0, "x")).unwrap();
        fs::write(&file, format!("{line}\n").repeat(KEEP * 2)).unwrap();
        append(&file, &entry(9, "last")).unwrap();
        let content = fs::read_to_string(&file).unwrap();
        assert_eq!(content.lines().count(), KEEP);
        assert!(content.ends_with("\"needsUser\":false}\n") && content.contains("last"));
        fs::remove_file(&file).unwrap();
    }
}
