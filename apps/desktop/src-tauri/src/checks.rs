use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tokio::process::Command;

use crate::error::AppResult;
use crate::jsonfile::read_optional;

const MAX_OUTPUT_CHARS: usize = 20_000;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(15 * 60);

fn package_manager(project: &Path) -> &'static str {
    if project.join("pnpm-lock.yaml").is_file() {
        "pnpm"
    } else if project.join("yarn.lock").is_file() {
        "yarn"
    } else if project.join("bun.lockb").is_file() || project.join("bun.lock").is_file() {
        "bun"
    } else {
        "npm"
    }
}

/// Guesses the commands that verify a project, from the build files at its root.
pub fn detect(project: &Path) -> Vec<String> {
    let mut commands = Vec::new();
    if let Ok(Some(package)) = read_optional(&project.join("package.json")) {
        let manager = package_manager(project);
        let scripts = package.get("scripts").and_then(Value::as_object);
        for script in ["typecheck", "lint", "test", "build"] {
            let defined = scripts.and_then(|scripts| scripts.get(script)).and_then(Value::as_str);
            if defined.is_some_and(|body| !body.contains("no test specified")) {
                commands.push(format!("{manager} run {script}"));
            }
        }
    }
    if project.join("Cargo.toml").is_file() {
        commands.push("cargo test".into());
    }
    if project.join("go.mod").is_file() {
        commands.push("go test ./...".into());
    }
    if project.join("pom.xml").is_file() {
        commands.push("mvn -q test".into());
    }
    if project.join("build.gradle").is_file() || project.join("build.gradle.kts").is_file() {
        let wrapper = if cfg!(windows) { "gradlew.bat" } else { "./gradlew" };
        let has_wrapper = project.join("gradlew").is_file() || project.join("gradlew.bat").is_file();
        commands.push(format!("{} test", if has_wrapper { wrapper } else { "gradle" }));
    }
    if project.join("pyproject.toml").is_file() || project.join("pytest.ini").is_file() {
        commands.push("pytest".into());
    }
    commands
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub command: String,
    pub passed: bool,
    pub exit_code: Option<i32>,
    pub output: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRun {
    pub passed: bool,
    pub results: Vec<CheckResult>,
}

/// Keeps the end of long output, where compilers and test runners print the failure.
pub fn tail(text: &str, max_chars: usize) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_owned();
    }
    let kept: String = text.chars().skip(count - max_chars).collect();
    format!("[… {} earlier characters omitted …]\n{kept}", count - max_chars)
}

async fn run_one(dir: &Path, command_line: &str) -> CheckResult {
    let started = Instant::now();
    let mut command = if cfg!(windows) {
        let mut command = Command::new("cmd");
        command.args(["/D", "/S", "/C", command_line]);
        command
    } else {
        let mut command = Command::new("sh");
        command.args(["-c", command_line]);
        command
    };
    command.env_clear().envs(crate::system_env::current());
    command.current_dir(dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let finish = |passed: bool, exit_code: Option<i32>, output: String| CheckResult {
        command: command_line.to_owned(),
        passed,
        exit_code,
        output: tail(output.trim(), MAX_OUTPUT_CHARS),
        duration_ms: started.elapsed().as_millis() as u64,
    };
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return finish(false, None, format!("could not start the command: {error}")),
    };
    match tokio::time::timeout(COMMAND_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => {
            let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            finish(output.status.success(), output.status.code(), text)
        }
        Ok(Err(error)) => finish(false, None, format!("the command failed to run: {error}")),
        Err(_) => finish(false, None, format!("timed out after {} minutes", COMMAND_TIMEOUT.as_secs() / 60)),
    }
}

/// Runs the commands in order and stops at the first failure, so the output shown is the first thing to fix.
pub async fn run(dir: &Path, commands: &[String]) -> AppResult<CheckRun> {
    let mut results = Vec::new();
    for command in commands {
        let result = run_one(dir, command).await;
        let passed = result.passed;
        results.push(result);
        if !passed {
            break;
        }
    }
    Ok(CheckRun { passed: results.iter().all(|result| result.passed), results })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn project(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cucicode-checks-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn detects_node_scripts_with_the_right_package_manager() {
        let dir = project("node");
        fs::write(dir.join("package.json"), r#"{"scripts":{"test":"vitest run","build":"vite build","dev":"vite","lint":"eslint ."}}"#).unwrap();
        assert_eq!(detect(&dir), vec!["npm run lint", "npm run test", "npm run build"]);
        fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();
        assert_eq!(detect(&dir), vec!["pnpm run lint", "pnpm run test", "pnpm run build"]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn skips_the_npm_placeholder_test_script_and_detects_other_stacks() {
        let dir = project("mixed");
        fs::write(dir.join("package.json"), r#"{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}"#).unwrap();
        fs::write(dir.join("Cargo.toml"), "[package]").unwrap();
        fs::write(dir.join("go.mod"), "module x").unwrap();
        assert_eq!(detect(&dir), vec!["cargo test", "go test ./..."]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn nothing_is_detected_in_an_unknown_project() {
        let dir = project("unknown");
        assert!(detect(&dir).is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn tail_keeps_the_end_and_says_what_was_cut() {
        assert_eq!(tail("short", 10), "short");
        let cut = tail("0123456789", 4);
        assert!(cut.ends_with("6789") && cut.contains("6 earlier characters"));
    }

    #[tokio::test]
    async fn runs_commands_in_order_and_stops_at_the_first_failure() {
        let dir = project("run");
        let commands = vec!["echo first".to_owned(), "exit 3".to_owned(), "echo never".to_owned()];
        let run = run(&dir, &commands).await.unwrap();
        assert!(!run.passed);
        assert_eq!(run.results.len(), 2);
        assert!(run.results[0].passed && run.results[0].output.contains("first"));
        assert_eq!(run.results[1].exit_code, Some(3));
        let ok = super::run(&dir, &["echo fine".to_owned()]).await.unwrap();
        assert!(ok.passed);
        assert!(super::run(&dir, &[]).await.unwrap().passed, "no checks configured counts as passing");
        fs::remove_dir_all(dir).unwrap();
    }
}
