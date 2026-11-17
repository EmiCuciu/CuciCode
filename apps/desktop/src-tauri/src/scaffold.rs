use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::error::{AppError, AppResult};
use crate::git_ops::git;
use crate::jsonfile::{read_optional, write_atomic};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Template {
    Empty,
    Node,
    Python,
    Rust,
    Java,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaffoldSpec {
    pub name: String,
    pub parent: PathBuf,
    pub template: Template,
    pub git_init: bool,
    pub gitignore: bool,
    pub claude_md: bool,
    pub code_rules: bool,
    pub stories: bool,
    pub pipeline: bool,
    pub predefined_routing: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub step: String,
    pub ok: bool,
    pub detail: String,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Invalid(message.into())
}

/// A folder name that works on every platform and as a repository name.
pub fn check_name(name: &str) -> AppResult<()> {
    let valid = !name.is_empty()
        && name.len() <= 100
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !name.starts_with('.')
        && !name.ends_with('.');
    valid.then_some(()).ok_or_else(|| invalid("use letters, digits, - _ and . for the project name"))
}

const GITIGNORE_BASE: &str = "# Secrets and local configuration\n.env*\n!.env.example\n*.pem\n*.key\nsecrets/\n\n# Claude Code and CuciCode personal files\n.claude/settings.local.json\n.claude/cucicode/*.local.json\n.claude/worktrees/\nCLAUDE.local.md\n\n# Editors and OS\n.idea/\n.vscode/*\n!.vscode/extensions.json\n*.swp\n.DS_Store\nThumbs.db\n\n# Logs\n*.log\n";

pub fn gitignore(template: Template) -> String {
    let build = match template {
        Template::Node => "\n# Build output\nnode_modules/\ndist/\ncoverage/\n",
        Template::Python => "\n# Build output\n__pycache__/\n*.py[cod]\n.venv/\nbuild/\ndist/\n*.egg-info/\n.pytest_cache/\n",
        Template::Rust => "\n# Build output\ntarget/\n",
        Template::Java => "\n# Build output\ntarget/\n*.class\n",
        Template::Empty => "\n# Build output\nbuild/\ndist/\nout/\n",
    };
    format!("{GITIGNORE_BASE}{build}")
}

fn test_command(template: Template) -> &'static str {
    match template {
        Template::Node => "npm test",
        Template::Python => "pytest",
        Template::Rust => "cargo test",
        Template::Java => "mvn -q test",
        Template::Empty => "(none yet)",
    }
}

/// Starter files for each stack, kept to the minimum that runs its own test command.
pub fn template_files(template: Template, name: &str) -> Vec<(String, String)> {
    let crate_name = name.replace(['-', '.'], "_").to_lowercase();
    let files: Vec<(&'static str, String)> = match template {
        Template::Java => return java_files(name),
        Template::Empty => vec![],
        Template::Node => vec![
            ("package.json", serde_json::to_string_pretty(&json!({ "name": name.to_lowercase(), "version": "0.1.0", "private": true, "type": "module", "scripts": { "test": "node --test" } })).unwrap_or_default() + "\n"),
            ("src/index.js", "export function hello(name) {\n  return `Hello, ${name}!`;\n}\n".into()),
            ("src/index.test.js", "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { hello } from './index.js';\n\ntest('greets by name', () => {\n  assert.equal(hello('Ann'), 'Hello, Ann!');\n});\n".into()),
        ],
        Template::Python => vec![
            ("pyproject.toml", format!("[project]\nname = \"{crate_name}\"\nversion = \"0.1.0\"\nrequires-python = \">=3.10\"\n\n[tool.pytest.ini_options]\npythonpath = [\"src\"]\n")),
            ("src/app.py", "def hello(name: str) -> str:\n    return f\"Hello, {name}!\"\n".into()),
            ("tests/test_app.py", "from app import hello\n\n\ndef test_greets_by_name():\n    assert hello(\"Ann\") == \"Hello, Ann!\"\n".into()),
        ],
        Template::Rust => vec![
            ("Cargo.toml", format!("[package]\nname = \"{crate_name}\"\nversion = \"0.1.0\"\nedition = \"2021\"\n")),
            ("src/main.rs", "fn hello(name: &str) -> String {\n    format!(\"Hello, {name}!\")\n}\n\nfn main() {\n    println!(\"{}\", hello(\"world\"));\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn greets_by_name() {\n        assert_eq!(super::hello(\"Ann\"), \"Hello, Ann!\");\n    }\n}\n".into()),
        ],
    };
    files.into_iter().map(|(path, content)| (path.to_owned(), content)).collect()
}

/// A Java package segment from a project name: lowercase letters and digits, never starting with a digit.
pub fn java_package(name: &str) -> String {
    let cleaned: String = name.chars().filter(char::is_ascii_alphanumeric).collect::<String>().to_lowercase();
    if cleaned.chars().next().is_none_or(|first| first.is_ascii_digit()) {
        format!("app{cleaned}")
    } else {
        cleaned
    }
}

const JAVA_POM: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <groupId>com.example</groupId>
  <artifactId>__ARTIFACT__</artifactId>
  <version>0.1.0-SNAPSHOT</version>

  <properties>
    <maven.compiler.release>21</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>

  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>6.1.3</version>
      <scope>test</scope>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.6.1</version>
      </plugin>
    </plugins>
  </build>
</project>
"#;

const JAVA_SERVICE: &str = r#"package com.example.__PACKAGE__;

/**
 * Builds the greetings the application shows to people.
 */
public class GreetingService {

    public String greet(String name) {
        return "Hello, " + name + "!";
    }
}
"#;

const JAVA_TEST: &str = r#"package com.example.__PACKAGE__;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class GreetingServiceTest {

    @Test
    void greetsByName() {
        assertEquals("Hello, Ann!", new GreetingService().greet("Ann"));
    }
}
"#;

fn java_files(name: &str) -> Vec<(String, String)> {
    let package = java_package(name);
    vec![
        ("pom.xml".to_owned(), JAVA_POM.replace("__ARTIFACT__", &name.to_lowercase())),
        (format!("src/main/java/com/example/{package}/GreetingService.java"), JAVA_SERVICE.replace("__PACKAGE__", &package)),
        (format!("src/test/java/com/example/{package}/GreetingServiceTest.java"), JAVA_TEST.replace("__PACKAGE__", &package)),
    ]
}

pub fn claude_md(name: &str, template: Template) -> String {
    let stack = match template {
        Template::Node => "Node.js (ES modules), tests with node:test",
        Template::Python => "Python 3, tests with pytest",
        Template::Rust => "Rust, tests with cargo test",
        Template::Java => "Java 21 with Maven, tests with JUnit 5",
        Template::Empty => "not chosen yet",
    };
    format!(
        "# {name}\n\n## Stack\n\n{stack}.\n\n## Commands\n\n- Test: `{}`\n\n## Workflow\n\n- Plans are written to `Plans/<feature>.md` and stories to `Stories/`, one file per story.\n- Do not edit files outside a story's `owned_files` while implementing it.\n- Secrets come from the environment (`.env`, never committed); do not write them into code.\n\nRun `/init` to extend this file once the project has real code.\n",
        test_command(template)
    )
}

fn merge_into(path: &Path, patch: Map<String, Value>) -> AppResult<()> {
    let mut document = match read_optional(path)? {
        Some(Value::Object(object)) => object,
        _ => Map::new(),
    };
    for (key, value) in patch {
        document.insert(key, value);
    }
    write_atomic(path, &Value::Object(document))
}

fn write_file(root: &Path, relative: &str, content: &str) -> AppResult<()> {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)?;
    Ok(())
}

const DEFAULT_RULES: &str = "# Code Rules\n\nManaged by CuciCode (Settings → Workflow → Code Rules). Follow these rules in every change.\n\n- Do not add code comments; make the code explain itself through names and structure.\n- Every service class has a Javadoc (or equivalent doc comment) describing its responsibility.\n- No hardcoded values: URLs, credentials, limits and environment-specific values come from configuration.\n- Follow the naming and folder structure already used in the project; do not introduce a new convention.\n";

/// Creates the project folder and its local files. Remote repositories and plugins are separate steps.
/// Each step reports its own result; a failing step does not undo the earlier ones.
pub fn scaffold(spec: &ScaffoldSpec) -> AppResult<(PathBuf, Vec<StepResult>)> {
    check_name(&spec.name)?;
    if !spec.parent.is_dir() {
        return Err(invalid(format!("{} is not a folder", spec.parent.display())));
    }
    let root = spec.parent.join(&spec.name);
    if root.exists() && fs::read_dir(&root).map(|mut entries| entries.next().is_some()).unwrap_or(true) {
        return Err(invalid(format!("{} already exists and is not empty", root.display())));
    }
    fs::create_dir_all(&root)?;
    let mut results = vec![StepResult { step: "folder".into(), ok: true, detail: root.display().to_string() }];
    let mut run = |step: &str, work: &dyn Fn() -> AppResult<String>| {
        let result = work();
        results.push(StepResult { step: step.into(), ok: result.is_ok(), detail: result.unwrap_or_else(|error| error.to_string()) });
    };

    run("template", &|| {
        let files = template_files(spec.template, &spec.name);
        for (path, content) in &files {
            write_file(&root, path, content)?;
        }
        Ok(format!("{} file(s)", files.len()))
    });
    if spec.gitignore {
        run("gitignore", &|| write_file(&root, ".gitignore", &gitignore(spec.template)).map(|()| ".gitignore".into()));
    }
    if spec.claude_md {
        run("claude_md", &|| write_file(&root, "CLAUDE.md", &claude_md(&spec.name, spec.template)).map(|()| "CLAUDE.md".into()));
    }
    if spec.stories {
        run("stories", &|| {
            write_file(&root, "Stories/archive/.gitkeep", "")?;
            write_file(&root, "Plans/.gitkeep", "")?;
            Ok("Stories/ and Plans/".into())
        });
    }
    run("claude_settings", &|| {
        let mut patch = Map::new();
        patch.insert("outputStyle".into(), json!("Concise"));
        merge_into(&root.join(".claude").join("settings.json"), patch).map(|()| ".claude/settings.json (output style Concise)".into())
    });
    if spec.code_rules || spec.pipeline || spec.predefined_routing {
        run("cucicode_settings", &|| {
            let mut patch = Map::new();
            patch.insert("version".into(), json!(1));
            if spec.code_rules {
                write_file(&root, ".claude/rules/cucicode-code-rules.md", DEFAULT_RULES)?;
                patch.insert("codeRules".into(), json!({ "enforce": { "secrets": true, "envValues": true, "envIgnored": true } }));
            }
            if spec.pipeline {
                patch.insert("pipeline".into(), json!({ "approvals": { "plan": true, "stories": true, "checks": false, "review": true }, "maxFixRounds": 2 }));
                patch.insert("git".into(), json!({ "pushMode": "local", "mergeMode": "approval", "requireCi": false, "maxParallelWorktrees": 2, "protectedPaths": [".env*", "**/secrets/**", "**/migrations/**"] }));
            }
            if spec.predefined_routing {
                patch.insert("routing".into(), json!({ "mode": "predefined" }));
            }
            merge_into(&root.join(".claude").join("cucicode").join("settings.json"), patch).map(|()| ".claude/cucicode/settings.json".into())
        });
    }
    if spec.git_init {
        run("git", &|| {
            git(&root, &["init", "-q", "-b", "main"])?;
            git(&root, &["add", "-A"])?;
            git(&root, &["commit", "-q", "-m", "Create project with CuciCode"])?;
            Ok("repository on main with a first commit".into())
        });
    }
    Ok((root, results))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(parent: &Path, name: &str, template: Template) -> ScaffoldSpec {
        ScaffoldSpec { name: name.into(), parent: parent.into(), template, git_init: true, gitignore: true, claude_md: true, code_rules: true, stories: true, pipeline: true, predefined_routing: false }
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cucicode-scaffold-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn project_names_must_be_portable() {
        for name in ["my-app", "api_v2", "Shop.Web"] {
            assert!(check_name(name).is_ok(), "{name}");
        }
        for name in ["", "a b", "../x", ".hidden", "trailing.", "x/y", "x:y"] {
            assert!(check_name(name).is_err(), "{name:?}");
        }
    }

    #[test]
    fn gitignore_always_covers_env_files_but_keeps_the_example() {
        for template in [Template::Empty, Template::Node, Template::Python, Template::Rust] {
            let content = gitignore(template);
            assert!(content.contains("\n.env*\n") && content.contains("!.env.example"), "{template:?}");
            assert!(content.contains(".claude/settings.local.json"));
        }
        assert!(gitignore(Template::Node).contains("node_modules/"));
        assert!(gitignore(Template::Rust).contains("target/"));
    }

    #[test]
    fn scaffolds_a_node_project_with_everything_committed_and_env_ignored() {
        let parent = temp("node");
        let (root, results) = scaffold(&spec(&parent, "shop", Template::Node)).unwrap();
        assert!(results.iter().all(|result| result.ok), "{results:?}");
        for file in ["package.json", "src/index.js", ".gitignore", "CLAUDE.md", "Stories/archive/.gitkeep", ".claude/rules/cucicode-code-rules.md"] {
            assert!(root.join(file).is_file(), "{file} missing");
        }
        let settings: Value = serde_json::from_str(&fs::read_to_string(root.join(".claude/settings.json")).unwrap()).unwrap();
        assert_eq!(settings["outputStyle"], json!("Concise"));
        let cucicode: Value = serde_json::from_str(&fs::read_to_string(root.join(".claude/cucicode/settings.json")).unwrap()).unwrap();
        assert_eq!(cucicode["pipeline"]["approvals"]["plan"], json!(true));
        assert_eq!(cucicode["codeRules"]["enforce"]["secrets"], json!(true));
        assert!(cucicode.get("routing").is_none());
        assert!(git(&root, &["status", "--porcelain"]).unwrap().trim().is_empty());
        fs::write(root.join(".env"), "TOKEN=abc").unwrap();
        assert!(git(&root, &["status", "--porcelain"]).unwrap().trim().is_empty(), ".env must be ignored");
        assert!(git(&root, &["check-ignore", ".env.example"]).is_err(), ".env.example must not be ignored");
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn the_node_template_passes_its_own_test_command() {
        let parent = temp("node-test");
        let (root, _) = scaffold(&ScaffoldSpec { git_init: false, ..spec(&parent, "starter", Template::Node) }).unwrap();
        let output = std::process::Command::new("node").arg("--test").current_dir(&root).output().expect("run node");
        fs::remove_dir_all(parent).unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stdout));
    }

    #[test]
    fn java_packages_are_valid_identifiers() {
        assert_eq!(java_package("my-app"), "myapp");
        assert_eq!(java_package("Shop.Web"), "shopweb");
        assert_eq!(java_package("9lives"), "app9lives");
        assert_eq!(java_package("-"), "app");
    }

    #[test]
    fn scaffolds_a_java_project_whose_tests_pass_with_maven() {
        let parent = temp("java");
        let (root, results) = scaffold(&ScaffoldSpec { git_init: false, ..spec(&parent, "order-api", Template::Java) }).unwrap();
        assert!(results.iter().all(|result| result.ok), "{results:?}");
        for file in ["pom.xml", "src/main/java/com/example/orderapi/GreetingService.java", "src/test/java/com/example/orderapi/GreetingServiceTest.java"] {
            assert!(root.join(file).is_file(), "{file} missing");
        }
        assert!(fs::read_to_string(root.join("pom.xml")).unwrap().contains("<artifactId>order-api</artifactId>"));
        assert!(fs::read_to_string(root.join(".gitignore")).unwrap().contains("target/"));
        assert!(fs::read_to_string(root.join("CLAUDE.md")).unwrap().contains("mvn -q test"));
        let maven = if cfg!(windows) { "mvn.cmd" } else { "mvn" };
        match std::process::Command::new(maven).args(["-q", "test"]).current_dir(&root).output() {
            Ok(output) => assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stdout)),
            Err(error) => eprintln!("skipping the Maven run: {error}"),
        }
        fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn refuses_a_non_empty_folder_and_skips_unchecked_steps() {
        let parent = temp("existing");
        fs::create_dir_all(parent.join("taken")).unwrap();
        fs::write(parent.join("taken/file.txt"), "x").unwrap();
        assert!(scaffold(&spec(&parent, "taken", Template::Empty)).is_err());
        let minimal = ScaffoldSpec { git_init: false, gitignore: false, claude_md: false, code_rules: false, stories: false, pipeline: false, predefined_routing: true, ..spec(&parent, "bare", Template::Empty) };
        let (root, results) = scaffold(&minimal).unwrap();
        let steps: Vec<&str> = results.iter().map(|result| result.step.as_str()).collect();
        assert_eq!(steps, vec!["folder", "template", "claude_settings", "cucicode_settings"]);
        assert!(!root.join(".git").exists() && !root.join("CLAUDE.md").exists());
        fs::remove_dir_all(parent).unwrap();
    }
}
