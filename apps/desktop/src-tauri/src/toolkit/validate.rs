use serde::Serialize;
use serde_json::{Map, Value};

use super::frontmatter;
use super::model::ItemKind;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub severity: Severity,
    pub field: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
const PERMISSION_MODES: &[&str] = &["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan", "manual"];
const MEMORY_SCOPES: &[&str] = &["user", "project", "local"];
const MODEL_ALIASES: &[&str] = &["sonnet", "opus", "haiku", "fable", "inherit"];

const AGENT_FIELDS: &[&str] = &[
    "name", "description", "tools", "disallowedTools", "model", "effort", "permissionMode", "maxTurns", "autoCompactWindow", "skills",
    "mcpServers", "hooks", "memory", "background", "omitClaudeMd", "isolation", "color", "initialPrompt", "experimental",
];
const SKILL_FIELDS: &[&str] = &[
    "name", "description", "when_to_use", "argument-hint", "arguments", "disable-model-invocation", "user-invocable", "allowed-tools",
    "disallowed-tools", "model", "effort", "context", "agent", "background", "hooks", "paths", "shell", "metadata", "license", "compatibility",
];
const OUTPUT_STYLE_FIELDS: &[&str] = &["name", "description", "keep-coding-instructions", "force-for-plugin"];
const RULE_FIELDS: &[&str] = &["paths", "description"];

fn problem(severity: Severity, field: &str, message: impl Into<String>) -> Problem {
    Problem { severity, field: Some(field.to_owned()), message: message.into() }
}

fn text<'a>(frontmatter: &'a Map<String, Value>, field: &str) -> Option<&'a str> {
    frontmatter.get(field).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty())
}

fn require(frontmatter: &Map<String, Value>, field: &str, why: &str, problems: &mut Vec<Problem>) {
    if text(frontmatter, field).is_none() {
        problems.push(problem(Severity::Error, field, format!("\"{field}\" is required: {why}")));
    }
}

fn one_of(frontmatter: &Map<String, Value>, field: &str, allowed: &[&str], problems: &mut Vec<Problem>) {
    if let Some(value) = frontmatter.get(field) {
        if !value.as_str().is_some_and(|value| allowed.contains(&value)) {
            problems.push(problem(Severity::Error, field, format!("\"{field}\" must be one of: {}", allowed.join(", "))));
        }
    }
}

fn check_model(frontmatter: &Map<String, Value>, problems: &mut Vec<Problem>) {
    if let Some(model) = text(frontmatter, "model") {
        if !MODEL_ALIASES.contains(&model) && !model.starts_with("claude-") {
            problems.push(problem(Severity::Warning, "model", format!("\"{model}\" is not a known alias ({}) or a full model ID", MODEL_ALIASES.join(", "))));
        }
    }
}

fn unknown_fields(frontmatter: &Map<String, Value>, known: &[&str], problems: &mut Vec<Problem>) {
    for field in frontmatter.keys().filter(|field| !known.contains(&field.as_str())) {
        problems.push(problem(Severity::Warning, field, format!("\"{field}\" is not a documented field; Claude Code ignores unknown fields")));
    }
}

/// Checks a markdown item against the frontmatter fields documented for its kind.
pub fn validate(kind: ItemKind, content: &str) -> Vec<Problem> {
    let document = frontmatter::parse(content);
    let mut problems = Vec::new();
    if let Some(error) = document.error {
        problems.push(Problem { severity: Severity::Error, field: None, message: error });
        return problems;
    }
    let fields = &document.frontmatter;
    match kind {
        ItemKind::Agent => {
            require(fields, "name", "it is how the agent is invoked", &mut problems);
            require(fields, "description", "Claude uses it to decide when to delegate to this agent", &mut problems);
            one_of(fields, "effort", EFFORTS, &mut problems);
            one_of(fields, "permissionMode", PERMISSION_MODES, &mut problems);
            one_of(fields, "memory", MEMORY_SCOPES, &mut problems);
            one_of(fields, "isolation", &["worktree"], &mut problems);
            check_model(fields, &mut problems);
            unknown_fields(fields, AGENT_FIELDS, &mut problems);
        }
        ItemKind::Skill | ItemKind::Command => {
            if kind == ItemKind::Skill && text(fields, "description").is_none() {
                problems.push(problem(Severity::Warning, "description", "without a description Claude cannot tell when to use this skill"));
            }
            one_of(fields, "effort", EFFORTS, &mut problems);
            one_of(fields, "context", &["fork"], &mut problems);
            one_of(fields, "shell", &["bash", "powershell"], &mut problems);
            check_model(fields, &mut problems);
            unknown_fields(fields, SKILL_FIELDS, &mut problems);
        }
        ItemKind::OutputStyle => {
            require(fields, "name", "it is the value stored in the outputStyle setting", &mut problems);
            unknown_fields(fields, OUTPUT_STYLE_FIELDS, &mut problems);
        }
        ItemKind::Rule => unknown_fields(fields, RULE_FIELDS, &mut problems),
        ItemKind::Hook | ItemKind::Mcp => {}
    }
    if document.body.trim().is_empty() && kind != ItemKind::Rule {
        problems.push(Problem { severity: Severity::Warning, field: None, message: "the body is empty, so there are no instructions".into() });
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;

    fn errors(problems: &[Problem]) -> Vec<&str> {
        problems.iter().filter(|problem| problem.severity == Severity::Error).filter_map(|problem| problem.field.as_deref()).collect()
    }

    #[test]
    fn a_complete_agent_has_no_problems() {
        let content = "---\nname: reviewer\ndescription: Reviews diffs\nmodel: sonnet\neffort: high\nisolation: worktree\n---\nReview the diff.";
        assert!(validate(ItemKind::Agent, content).is_empty());
    }

    #[test]
    fn an_agent_needs_name_and_description_and_valid_enums() {
        let problems = validate(ItemKind::Agent, "---\neffort: extreme\npermissionMode: yolo\n---\nBody");
        assert_eq!(errors(&problems), vec!["name", "description", "effort", "permissionMode"]);
    }

    #[test]
    fn unknown_fields_and_models_are_warnings_not_errors() {
        let problems = validate(ItemKind::Agent, "---\nname: a\ndescription: b\nmodel: gpt-4\ncolour: red\n---\nBody");
        assert!(errors(&problems).is_empty());
        let warned: Vec<&str> = problems.iter().filter_map(|problem| problem.field.as_deref()).collect();
        assert_eq!(warned, vec!["model", "colour"]);
    }

    #[test]
    fn full_model_ids_are_accepted() {
        assert!(validate(ItemKind::Agent, "---\nname: a\ndescription: b\nmodel: claude-sonnet-5-5\n---\nBody").is_empty());
    }

    #[test]
    fn a_skill_without_description_or_body_gets_warnings() {
        let problems = validate(ItemKind::Skill, "---\ncontext: fork\n---\n");
        assert!(errors(&problems).is_empty());
        assert_eq!(problems.len(), 2);
    }

    #[test]
    fn broken_yaml_is_the_only_problem_reported() {
        let problems = validate(ItemKind::Skill, "---\nname: [x\n---\nBody");
        assert_eq!(problems.len(), 1);
        assert!(problems[0].message.contains("invalid YAML"));
    }

    #[test]
    fn rules_may_have_no_frontmatter_and_no_body_warning() {
        assert!(validate(ItemKind::Rule, "").is_empty());
        assert!(validate(ItemKind::Rule, "---\npaths: src/**\n---\n# Rules").is_empty());
    }
}
