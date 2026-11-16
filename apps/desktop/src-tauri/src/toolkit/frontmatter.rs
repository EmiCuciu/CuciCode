use serde_json::{Map, Number, Value};
use yaml_rust2::{Yaml, YamlLoader};

#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    pub frontmatter: Map<String, Value>,
    pub body: String,
    pub error: Option<String>,
}

fn yaml_to_json(yaml: &Yaml) -> Value {
    match yaml {
        Yaml::Real(text) => text
            .parse::<f64>()
            .ok()
            .and_then(Number::from_f64)
            .map_or_else(|| Value::String(text.clone()), Value::Number),
        Yaml::Integer(number) => Value::Number((*number).into()),
        Yaml::String(text) => Value::String(text.clone()),
        Yaml::Boolean(flag) => Value::Bool(*flag),
        Yaml::Array(items) => Value::Array(items.iter().map(yaml_to_json).collect()),
        Yaml::Hash(entries) => Value::Object(
            entries
                .iter()
                .map(|(key, value)| (key_text(key), yaml_to_json(value)))
                .collect(),
        ),
        _ => Value::Null,
    }
}

fn key_text(key: &Yaml) -> String {
    match yaml_to_json(key) {
        Value::String(text) => text,
        other => other.to_string(),
    }
}

/// Splits a markdown file into YAML frontmatter and body. A file without
/// frontmatter is valid; malformed frontmatter is reported in `error`.
pub fn parse(text: &str) -> Document {
    let text = text.trim_start_matches('\u{feff}');
    let no_frontmatter = |error| Document { frontmatter: Map::new(), body: text.to_owned(), error };
    let Some(rest) = text.strip_prefix("---") else {
        return no_frontmatter(None);
    };
    let Some(rest) = rest.strip_prefix("\r\n").or_else(|| rest.strip_prefix('\n')) else {
        return no_frontmatter(None);
    };
    let mut yaml_end = None;
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            yaml_end = Some((offset, offset + line.len()));
            break;
        }
        offset += line.len();
    }
    let Some((yaml_end, body_start)) = yaml_end else {
        return no_frontmatter(Some("frontmatter is not closed with a --- line".into()));
    };
    let body = rest[body_start..].to_owned();
    match YamlLoader::load_from_str(&rest[..yaml_end]) {
        Ok(documents) => match documents.first().map(yaml_to_json) {
            Some(Value::Object(frontmatter)) => Document { frontmatter, body, error: None },
            None | Some(Value::Null) => Document { frontmatter: Map::new(), body, error: None },
            Some(_) => Document {
                frontmatter: Map::new(),
                body,
                error: Some("frontmatter must be a list of key: value pairs".into()),
            },
        },
        Err(error) => Document { frontmatter: Map::new(), body, error: Some(format!("invalid YAML: {error}")) },
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn reads_scalars_lists_and_nested_maps() {
        let document = parse("---\nname: reviewer\ndescription: Reviews diffs\ntools: Read, Grep\nmaxTurns: 5\nbackground: true\nskills:\n  - a\n  - b\nhooks:\n  Stop:\n    - matcher: x\n---\nBody text\n");
        assert_eq!(document.error, None);
        assert_eq!(document.body, "Body text\n");
        assert_eq!(document.frontmatter["name"], json!("reviewer"));
        assert_eq!(document.frontmatter["tools"], json!("Read, Grep"));
        assert_eq!(document.frontmatter["maxTurns"], json!(5));
        assert_eq!(document.frontmatter["background"], json!(true));
        assert_eq!(document.frontmatter["skills"], json!(["a", "b"]));
        assert_eq!(document.frontmatter["hooks"]["Stop"][0]["matcher"], json!("x"));
    }

    #[test]
    fn a_file_without_frontmatter_is_all_body() {
        let document = parse("# Rules\n\n--- not frontmatter\n");
        assert!(document.frontmatter.is_empty());
        assert_eq!(document.error, None);
        assert_eq!(document.body, "# Rules\n\n--- not frontmatter\n");
    }

    #[test]
    fn handles_windows_line_endings_and_a_byte_order_mark() {
        let document = parse("\u{feff}---\r\nname: x\r\n---\r\nBody\r\n");
        assert_eq!(document.frontmatter["name"], json!("x"));
        assert_eq!(document.body, "Body\r\n");
    }

    #[test]
    fn reports_unclosed_and_invalid_frontmatter() {
        assert!(parse("---\nname: x\nBody").error.unwrap().contains("not closed"));
        assert!(parse("---\nname: [unclosed\n---\nBody").error.unwrap().contains("invalid YAML"));
        assert!(parse("---\n- a\n- b\n---\n").error.unwrap().contains("key: value"));
    }

    #[test]
    fn empty_frontmatter_is_valid() {
        let document = parse("---\n---\nBody");
        assert!(document.frontmatter.is_empty());
        assert_eq!(document.error, None);
        assert_eq!(document.body, "Body");
    }
}
