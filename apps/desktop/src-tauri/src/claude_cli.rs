use std::path::Path;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};

/// Runs the installed `claude` command for operations Claude Code owns:
/// MCP servers in `.claude.json`, plugins and marketplaces.
fn run(args: &[&str], cwd: Option<&Path>) -> AppResult<String> {
    let program = std::env::var_os("CUCICODE_CLAUDE").unwrap_or_else(|| "claude".into());
    let mut command = Command::new(program);
    command.env_clear().envs(crate::system_env::current());
    command.args(args).stdin(Stdio::null());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output().map_err(|error| AppError::Invalid(format!("cannot run claude: {error}")))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let message = [stderr.trim(), stdout.trim()].into_iter().find(|text| !text.is_empty()).unwrap_or("no output").to_owned();
    Err(AppError::Invalid(format!("claude {} failed: {message}", args.first().copied().unwrap_or_default())))
}

fn check_name(kind: &str, name: &str) -> AppResult<()> {
    let valid = !name.is_empty() && !name.starts_with('-') && name.chars().all(|c| c.is_ascii_alphanumeric() || "._@-".contains(c));
    valid.then_some(()).ok_or_else(|| AppError::Invalid(format!("\"{name}\" is not a valid {kind} name: use letters, digits, . _ @ and -")))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CliScope {
    User,
    Project,
    Local,
}

impl CliScope {
    fn flag(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Project => "project",
            Self::Local => "local",
        }
    }

    fn needs_project(self) -> bool {
        self != Self::User
    }
}

fn scoped_cwd(scope: CliScope, project: Option<&Path>) -> AppResult<Option<&Path>> {
    if scope.needs_project() && project.is_none() {
        return Err(AppError::Invalid(format!("select a project to use the {} scope", scope.flag())));
    }
    Ok(project)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHealth {
    pub name: String,
    pub target: String,
    pub status: McpStatus,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpStatus {
    Connected,
    NeedsAuth,
    Failed,
    Unknown,
}

/// Parses the lines of `claude mcp list`, which look like `name: target - ✔ Connected`.
pub fn parse_mcp_list(output: &str) -> Vec<McpHealth> {
    output
        .lines()
        .filter_map(|line| {
            let (name, rest) = line.split_once(": ")?;
            let (target, detail) = rest.rsplit_once(" - ")?;
            let lowered = detail.to_lowercase();
            let status = if lowered.contains("needs auth") {
                McpStatus::NeedsAuth
            } else if lowered.contains("connected") && !lowered.contains("fail") {
                McpStatus::Connected
            } else if lowered.contains("fail") || lowered.contains("error") {
                McpStatus::Failed
            } else {
                McpStatus::Unknown
            };
            let detail = detail.trim_start_matches(|c: char| !c.is_alphanumeric()).trim().to_owned();
            Some(McpHealth { name: name.trim().to_owned(), target: target.trim().to_owned(), status, detail })
        })
        .collect()
}

pub fn mcp_health(project: Option<&Path>) -> AppResult<Vec<McpHealth>> {
    Ok(parse_mcp_list(&run(&["mcp", "list"], project)?))
}

pub fn mcp_add(scope: CliScope, name: &str, config: &Value, project: Option<&Path>) -> AppResult<()> {
    check_name("server", name)?;
    if !config.is_object() {
        return Err(AppError::Invalid("the server configuration must be a JSON object".into()));
    }
    let cwd = scoped_cwd(scope, project)?;
    run(&["mcp", "add-json", "--scope", scope.flag(), name, &config.to_string()], cwd).map(drop)
}

pub fn mcp_remove(scope: CliScope, name: &str, project: Option<&Path>) -> AppResult<()> {
    check_name("server", name)?;
    let cwd = scoped_cwd(scope, project)?;
    run(&["mcp", "remove", "--scope", scope.flag(), name], cwd).map(drop)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginAction {
    Install,
    Uninstall,
    Enable,
    Disable,
    Update,
}

pub fn plugin(action: PluginAction, plugin: &str, scope: CliScope, project: Option<&Path>) -> AppResult<String> {
    check_name("plugin", plugin)?;
    let cwd = scoped_cwd(scope, project)?;
    let verb = match action {
        PluginAction::Install => "install",
        PluginAction::Uninstall => "uninstall",
        PluginAction::Enable => "enable",
        PluginAction::Disable => "disable",
        PluginAction::Update => "update",
    };
    let mut args = vec!["plugin", verb, "--scope", scope.flag()];
    if action == PluginAction::Uninstall {
        args.push("--yes");
    }
    args.push(plugin);
    run(&args, cwd)
}

pub fn marketplace_add(source: &str, scope: CliScope, project: Option<&Path>) -> AppResult<String> {
    let source = source.trim();
    if source.is_empty() || source.starts_with('-') || source.chars().any(char::is_whitespace) {
        return Err(AppError::Invalid("enter a GitHub owner/repo, a git URL (GitHub, Bitbucket, any host) or a local path".into()));
    }
    let cwd = scoped_cwd(scope, project)?;
    run(&["plugin", "marketplace", "add", "--scope", scope.flag(), source], cwd)
}

pub fn marketplace_update(name: &str) -> AppResult<String> {
    check_name("marketplace", name)?;
    run(&["plugin", "marketplace", "update", name], None)
}

pub fn marketplace_remove(name: &str) -> AppResult<String> {
    check_name("marketplace", name)?;
    run(&["plugin", "marketplace", "remove", name], None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_health_lines_and_skips_the_rest() {
        let output = "Checking MCP server health…\n\nclaude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected\nclaude.ai Slack: https://mcp.slack.com/mcp - ! Needs authentication\ngithub: npx -y @mcp/server-github - ✗ Failed to connect\nodd: thing - something else\n";
        let health = parse_mcp_list(output);
        assert_eq!(health.len(), 4);
        assert_eq!(health[0], McpHealth { name: "claude.ai Gmail".into(), target: "https://gmailmcp.googleapis.com/mcp/v1".into(), status: McpStatus::Connected, detail: "Connected".into() });
        assert_eq!(health[1].status, McpStatus::NeedsAuth);
        assert_eq!(health[2].status, McpStatus::Failed);
        assert_eq!(health[2].target, "npx -y @mcp/server-github");
        assert_eq!(health[3].status, McpStatus::Unknown);
    }

    #[test]
    fn rejects_names_that_could_be_read_as_flags_or_shell_text() {
        for name in ["", "--scope", "-x", "a b", "a;b", "a$(x)"] {
            assert!(check_name("server", name).is_err(), "{name:?} should be rejected");
        }
        for name in ["github", "fmt@team-tools", "my_server.v2"] {
            assert!(check_name("server", name).is_ok(), "{name:?} should be accepted");
        }
    }

    #[test]
    fn project_scopes_need_a_project_and_bad_input_never_reaches_the_cli() {
        assert!(mcp_add(CliScope::Project, "x", &serde_json::json!({}), None).is_err());
        assert!(mcp_add(CliScope::User, "x", &serde_json::json!("not an object"), None).is_err());
        assert!(mcp_remove(CliScope::Local, "x", None).is_err());
        assert!(marketplace_add("--evil", CliScope::User, None).is_err());
        assert!(marketplace_add("two words", CliScope::User, None).is_err());
        assert!(plugin(PluginAction::Install, "-rf", CliScope::User, None).is_err());
    }
}
