use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppResult;
use crate::jsonfile::read_optional;

const HOUR_MS: u64 = 3_600_000;

/// One usage window as Claude Code last fetched it from Anthropic.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowUsage {
    pub utilization: f64,
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportedLimits {
    pub fetched_at_ms: u64,
    pub five_hour: Option<WindowUsage>,
    pub seven_day: Option<WindowUsage>,
}

fn window(utilization: &Value, key: &str) -> Option<WindowUsage> {
    let entry = utilization.get(key)?;
    Some(WindowUsage { utilization: entry.get("utilization")?.as_f64()?, resets_at: entry.get("resets_at").and_then(Value::as_str).map(str::to_owned) })
}

/// Reads the figures Claude Code caches in its state file. They are as fresh as its last fetch.
pub fn parse_limits(state: &Value) -> Option<ReportedLimits> {
    let cached = state.get("cachedUsageUtilization")?;
    let utilization = cached.get("utilization")?;
    Some(ReportedLimits { fetched_at_ms: cached.get("fetchedAtMs")?.as_u64()?, five_hour: window(utilization, "five_hour"), seven_day: window(utilization, "seven_day") })
}

pub fn reported_limits(state_file: &Path) -> AppResult<Option<ReportedLimits>> {
    Ok(read_optional(state_file)?.as_ref().and_then(parse_limits))
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    /// The encoded project folder name under `~/.claude/projects`.
    pub project: String,
    pub session_id: String,
    /// `main` for the main thread, otherwise the subagent type.
    pub agent: String,
    pub model: String,
    pub hour_start_ms: u64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub messages: u32,
}

#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type")]
    kind: String,
    timestamp: Option<String>,
    message: Option<Message>,
}

#[derive(Deserialize)]
struct Message {
    id: Option<String>,
    model: Option<String>,
    usage: Option<Usage>,
}

#[derive(Deserialize, Clone, Copy, Default)]
struct Usage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
}

/// Parses an RFC 3339 UTC timestamp such as `2026-11-16T11:05:15.675Z` to milliseconds since the epoch.
pub fn parse_timestamp_ms(text: &str) -> Option<u64> {
    let bytes = text.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let number = |range: std::ops::Range<usize>| text.get(range)?.parse::<u64>().ok();
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let millis = text.get(19..).and_then(|rest| rest.strip_prefix('.')).map(|rest| rest.chars().take_while(char::is_ascii_digit).take(3).collect::<String>()).and_then(|digits| format!("{digits:0<3}").parse::<u64>().ok()).unwrap_or(0);
    // Days from the civil date (proleptic Gregorian), counted from 1970-01-01.
    let shifted_year = if month <= 2 { year - 1 } else { year };
    let era = shifted_year / 400;
    let year_of_era = shifted_year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = (era * 146_097 + day_of_era).checked_sub(719_468)?;
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis)
}

/// Adds one transcript's usage to the totals. Each assistant message is counted once, however many lines repeat it.
pub fn read_transcript(reader: impl BufRead, project: &str, session_id: &str, agent: &str, since_ms: u64, rows: &mut HashMap<(String, String, String, String, u64), UsageRow>) {
    let mut seen: HashMap<String, (u64, String, Usage)> = HashMap::new();
    for line in reader.lines().map_while(Result::ok) {
        if !line.contains("\"assistant\"") || !line.contains("\"usage\"") {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Line>(&line) else { continue };
        if parsed.kind != "assistant" {
            continue;
        }
        let Some(message) = parsed.message else { continue };
        let (Some(id), Some(usage)) = (message.id, message.usage) else { continue };
        let Some(timestamp) = parsed.timestamp.as_deref().and_then(parse_timestamp_ms) else { continue };
        seen.insert(id, (timestamp, message.model.unwrap_or_else(|| "unknown".into()), usage));
    }
    for (timestamp, model, usage) in seen.into_values() {
        if timestamp < since_ms || model.starts_with('<') {
            continue;
        }
        let hour = timestamp - timestamp % HOUR_MS;
        let key = (project.to_owned(), session_id.to_owned(), agent.to_owned(), model.clone(), hour);
        let row = rows.entry(key).or_insert_with(|| UsageRow { project: project.to_owned(), session_id: session_id.to_owned(), agent: agent.to_owned(), model, hour_start_ms: hour, ..UsageRow::default() });
        row.input += usage.input_tokens;
        row.output += usage.output_tokens;
        row.cache_read += usage.cache_read_input_tokens;
        row.cache_write += usage.cache_creation_input_tokens;
        row.messages += 1;
    }
}

fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path).and_then(|metadata| metadata.modified()).ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok()).map_or(0, |duration| duration.as_millis() as u64)
}

fn agent_type(meta_file: &Path) -> String {
    read_optional(meta_file).ok().flatten().and_then(|meta| meta.get("agentType").and_then(Value::as_str).map(str::to_owned)).unwrap_or_else(|| "subagent".into())
}

fn scan_project_dir(dir: &Path, project: &str, since_ms: u64, rows: &mut HashMap<(String, String, String, String, u64), UsageRow>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_file() && path.extension().is_some_and(|extension| extension == "jsonl") {
            if modified_ms(&path) < since_ms {
                continue;
            }
            let session = path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
            if let Ok(file) = File::open(&path) {
                read_transcript(BufReader::new(file), project, &session, "main", since_ms, rows);
            }
        } else if path.is_dir() {
            let session = entry.file_name().to_string_lossy().into_owned();
            let Ok(subagents) = fs::read_dir(path.join("subagents")) else { continue };
            for subagent in subagents.filter_map(Result::ok).map(|item| item.path()).filter(|item| item.extension().is_some_and(|extension| extension == "jsonl")) {
                if modified_ms(&subagent) < since_ms {
                    continue;
                }
                let agent = agent_type(&subagent.with_extension("meta.json"));
                if let Ok(file) = File::open(&subagent) {
                    read_transcript(BufReader::new(file), project, &session, &agent, since_ms, rows);
                }
            }
        }
    }
}

/// Token usage counted from transcripts, grouped by project folder, session, agent, model and hour.
///
/// The transcript format is internal to Claude Code and may change, so this is the only
/// place that reads it; lines it does not understand are skipped.
pub fn scan(projects_dir: &Path, since_ms: u64) -> Vec<UsageRow> {
    let mut rows = HashMap::new();
    if let Ok(entries) = fs::read_dir(projects_dir) {
        for entry in entries.filter_map(Result::ok).filter(|entry| entry.path().is_dir()) {
            let project = entry.file_name().to_string_lossy().into_owned();
            scan_project_dir(&entry.path(), &project, since_ms, &mut rows);
        }
    }
    let mut list: Vec<UsageRow> = rows.into_values().collect();
    list.sort_by(|left, right| (left.hour_start_ms, &left.project, &left.session_id, &left.agent, &left.model).cmp(&(right.hour_start_ms, &right.project, &right.session_id, &right.agent, &right.model)));
    list
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use serde_json::json;

    use super::*;

    fn assistant(id: &str, timestamp: &str, model: &str, input: u64, output: u64) -> String {
        json!({ "type": "assistant", "timestamp": timestamp, "message": { "id": id, "model": model, "usage": { "input_tokens": input, "output_tokens": output, "cache_read_input_tokens": 10, "cache_creation_input_tokens": 5 } } }).to_string()
    }

    #[test]
    fn parses_timestamps_to_epoch_milliseconds() {
        assert_eq!(parse_timestamp_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_timestamp_ms("2026-11-16T11:05:15.675Z"), Some(1_794_827_115_675));
        assert_eq!(parse_timestamp_ms("2024-02-29T23:59:59.9Z"), Some(1_709_251_199_900));
        assert_eq!(parse_timestamp_ms("2026-11-16T11:05:15+00:00"), Some(1_794_827_115_000));
        assert_eq!(parse_timestamp_ms("not a date"), None);
        assert_eq!(parse_timestamp_ms("2026-13-01T00:00:00Z"), None);
    }

    #[test]
    fn counts_each_message_once_and_groups_by_model_and_hour() {
        let transcript = [
            assistant("m1", "2026-11-16T11:05:15.000Z", "claude-sonnet", 100, 20),
            assistant("m1", "2026-11-16T11:05:16.000Z", "claude-sonnet", 100, 25),
            assistant("m2", "2026-11-16T11:40:00.000Z", "claude-sonnet", 50, 5),
            assistant("m3", "2026-11-16T12:01:00.000Z", "claude-haiku", 7, 3),
            json!({ "type": "user", "timestamp": "2026-11-16T11:00:00Z", "message": { "content": "the word \"assistant\" and \"usage\" in a prompt" } }).to_string(),
            "{ broken json \"assistant\" \"usage\"".to_owned(),
            assistant("m4", "2026-11-16T12:02:00.000Z", "<synthetic>", 999, 999),
        ]
        .join("\n");
        let mut rows = HashMap::new();
        read_transcript(Cursor::new(transcript), "proj", "s1", "main", 0, &mut rows);
        let mut list: Vec<UsageRow> = rows.into_values().collect();
        list.sort_by_key(|row| row.hour_start_ms);
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].model.as_str(), list[0].input, list[0].output, list[0].cache_read, list[0].cache_write, list[0].messages), ("claude-sonnet", 150, 30, 20, 10, 2));
        assert_eq!((list[1].model.as_str(), list[1].input, list[1].messages), ("claude-haiku", 7, 1));
        assert_eq!(list[1].hour_start_ms - list[0].hour_start_ms, HOUR_MS);
    }

    #[test]
    fn ignores_messages_older_than_the_requested_start() {
        let transcript = [assistant("old", "2026-11-15T10:00:00Z", "m", 1, 1), assistant("new", "2026-11-16T10:00:00Z", "m", 2, 2)].join("\n");
        let mut rows = HashMap::new();
        read_transcript(Cursor::new(transcript), "p", "s", "main", parse_timestamp_ms("2026-11-16T00:00:00Z").unwrap(), &mut rows);
        assert_eq!(rows.values().map(|row| row.input).sum::<u64>(), 2);
    }

    #[test]
    fn scans_main_and_subagent_transcripts_of_every_project() {
        let base = std::env::temp_dir().join(format!("cucicode-usage-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let project = base.join("C--work-app");
        let subagents = project.join("sess1").join("subagents");
        fs::create_dir_all(&subagents).unwrap();
        fs::write(project.join("sess1.jsonl"), assistant("a", "2026-11-16T10:00:00Z", "claude-sonnet", 10, 1)).unwrap();
        fs::write(subagents.join("agent-x1.jsonl"), assistant("b", "2026-11-16T10:10:00Z", "claude-haiku", 4, 2)).unwrap();
        fs::write(subagents.join("agent-x1.meta.json"), r#"{"agentType":"cucicode:explorer"}"#).unwrap();
        fs::write(subagents.join("agent-x2.jsonl"), assistant("c", "2026-11-16T10:20:00Z", "claude-haiku", 1, 1)).unwrap();
        let rows = scan(&base, 0);
        fs::remove_dir_all(&base).unwrap();
        let agents: Vec<(&str, u64)> = rows.iter().map(|row| (row.agent.as_str(), row.input)).collect();
        assert!(agents.contains(&("main", 10)));
        assert!(agents.contains(&("cucicode:explorer", 4)));
        assert!(agents.contains(&("subagent", 1)));
        assert!(rows.iter().all(|row| row.project == "C--work-app" && row.session_id == "sess1"));
    }

    #[test]
    fn reads_the_limits_claude_code_cached() {
        let state = json!({ "cachedUsageUtilization": { "fetchedAtMs": 1_794_854_289_832u64, "utilization": { "five_hour": { "utilization": 76, "resets_at": "2026-11-16T23:09:59+00:00" }, "seven_day": { "utilization": 44.5, "resets_at": null }, "seven_day_opus": null } } });
        let limits = parse_limits(&state).unwrap();
        assert_eq!(limits.fetched_at_ms, 1_794_854_289_832);
        assert_eq!(limits.five_hour, Some(WindowUsage { utilization: 76.0, resets_at: Some("2026-11-16T23:09:59+00:00".into()) }));
        assert_eq!(limits.seven_day, Some(WindowUsage { utilization: 44.5, resets_at: None }));
        assert_eq!(parse_limits(&json!({})), None);
    }
}
