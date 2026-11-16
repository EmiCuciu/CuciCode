use serde_json::{json, Value};

use super::model::{ItemKind, ItemScope, ToolkitItem};

pub struct Origin<'a> {
    pub scope: ItemScope,
    pub path: &'a str,
    pub relative_path: &'a str,
    pub plugin: Option<&'a str>,
    pub editable: bool,
}

fn hook_summary(handler: &Value) -> String {
    ["command", "url", "prompt", "tool"]
        .iter()
        .find_map(|key| handler.get(key).and_then(Value::as_str))
        .unwrap_or_default()
        .to_owned()
}

/// Reads the `hooks` object of a settings file or a plugin's `hooks.json`.
pub fn hooks(hooks: &Value, origin: &Origin) -> Vec<ToolkitItem> {
    let Some(events) = hooks.as_object() else {
        return Vec::new();
    };
    let mut items = Vec::new();
    for (event, groups) in events {
        for (group_index, group) in groups.as_array().into_iter().flatten().enumerate() {
            let matcher = group.get("matcher").and_then(Value::as_str).filter(|matcher| !matcher.is_empty());
            for (handler_index, handler) in group.get("hooks").and_then(Value::as_array).into_iter().flatten().enumerate() {
                let handler_type = handler.get("type").and_then(Value::as_str).unwrap_or("command");
                let summary = hook_summary(handler);
                items.push(ToolkitItem {
                    id: format!("hook:{}#{event}/{group_index}/{handler_index}", origin.path),
                    kind: ItemKind::Hook,
                    scope: origin.scope,
                    name: matcher.map_or_else(|| event.clone(), |matcher| format!("{event} · {matcher}")),
                    description: Some(summary.clone()),
                    model: handler.get("model").and_then(Value::as_str).map(str::to_owned),
                    path: origin.path.to_owned(),
                    relative_path: origin.relative_path.to_owned(),
                    plugin: origin.plugin.map(str::to_owned),
                    frontmatter: json!({}),
                    detail: json!({
                        "event": event,
                        "matcher": matcher,
                        "type": handler_type,
                        "run": summary,
                        "timeout": handler.get("timeout"),
                        "groupIndex": group_index,
                        "handlerIndex": handler_index,
                        "handler": handler,
                    }),
                    editable: origin.editable,
                    problem: None,
                    conflict: None,
                });
            }
        }
    }
    items
}

fn keys(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_object).map(|object| object.keys().cloned().collect()).unwrap_or_default()
}

/// Reads an `mcpServers` object. Environment and header values are never
/// returned, only their names, because they often hold secrets.
pub fn mcp_servers(servers: &Value, origin: &Origin) -> Vec<ToolkitItem> {
    let Some(servers) = servers.as_object() else {
        return Vec::new();
    };
    servers
        .iter()
        .map(|(name, config)| {
            let command = config.get("command").and_then(Value::as_str);
            let url = config.get("url").and_then(Value::as_str);
            let transport = config
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or(if url.is_some() && command.is_none() { "http" } else { "stdio" });
            let args: Vec<&str> = config.get("args").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
            let summary = match (command, url) {
                (Some(command), _) => format!("{command} {}", args.join(" ")).trim().to_owned(),
                (None, Some(url)) => url.to_owned(),
                (None, None) => String::new(),
            };
            ToolkitItem {
                id: format!("mcp:{}#{name}", origin.path),
                kind: ItemKind::Mcp,
                scope: origin.scope,
                name: name.clone(),
                description: Some(summary),
                model: None,
                path: origin.path.to_owned(),
                relative_path: origin.relative_path.to_owned(),
                plugin: origin.plugin.map(str::to_owned),
                frontmatter: json!({}),
                detail: json!({
                    "transport": transport,
                    "command": command,
                    "args": args,
                    "url": url,
                    "envKeys": keys(config.get("env")),
                    "headerKeys": keys(config.get("headers")),
                }),
                editable: origin.editable,
                problem: None,
                conflict: None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: Origin = Origin { scope: ItemScope::Project, path: "/p/.claude/settings.json", relative_path: ".claude/settings.json", plugin: None, editable: true };

    #[test]
    fn expands_each_hook_handler_into_an_item() {
        let settings = json!({
            "PreToolUse": [
                { "matcher": "Bash", "hooks": [{ "type": "command", "command": "guard.sh", "timeout": 10 }, { "type": "http", "url": "http://x" }] },
                { "hooks": [{ "type": "prompt", "prompt": "check" }] }
            ],
            "Stop": [{ "hooks": [{ "type": "command", "command": "done.sh" }] }]
        });
        let items = hooks(&settings, &ORIGIN);
        assert_eq!(items.len(), 4);
        assert_eq!(items[0].name, "PreToolUse · Bash");
        assert_eq!(items[0].detail["run"], json!("guard.sh"));
        assert_eq!(items[0].detail["timeout"], json!(10));
        assert_eq!(items[1].detail["type"], json!("http"));
        assert_eq!(items[2].name, "PreToolUse");
        assert_eq!(items[2].id, "hook:/p/.claude/settings.json#PreToolUse/1/0");
        assert_eq!(items[3].name, "Stop");
    }

    #[test]
    fn describes_servers_without_exposing_secret_values() {
        let servers = json!({
            "github": { "command": "npx", "args": ["-y", "server-github"], "env": { "GITHUB_TOKEN": "ghp_secret" } },
            "linear": { "type": "http", "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer secret" } },
            "legacy": { "url": "https://x/sse" }
        });
        let items = mcp_servers(&servers, &ORIGIN);
        let find = |name: &str| items.iter().find(|item| item.name == name).unwrap();
        assert_eq!(find("github").detail["transport"], json!("stdio"));
        assert_eq!(find("github").description.as_deref(), Some("npx -y server-github"));
        assert_eq!(find("github").detail["envKeys"], json!(["GITHUB_TOKEN"]));
        assert_eq!(find("linear").detail["transport"], json!("http"));
        assert_eq!(find("linear").detail["headerKeys"], json!(["Authorization"]));
        assert_eq!(find("legacy").detail["transport"], json!("http"));
        let serialized = serde_json::to_string(&items).unwrap();
        assert!(!serialized.contains("ghp_secret") && !serialized.contains("Bearer secret"));
    }

    #[test]
    fn ignores_values_of_the_wrong_shape() {
        assert!(hooks(&json!([]), &ORIGIN).is_empty());
        assert!(mcp_servers(&json!("nope"), &ORIGIN).is_empty());
    }
}
