use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    Agent,
    Skill,
    Command,
    Hook,
    Mcp,
    OutputStyle,
    Rule,
}

impl ItemKind {
    pub fn folder(self) -> Option<&'static str> {
        match self {
            Self::Agent => Some("agents"),
            Self::Skill => Some("skills"),
            Self::Command => Some("commands"),
            Self::OutputStyle => Some("output-styles"),
            Self::Rule => Some("rules"),
            Self::Hook | Self::Mcp => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Skill => "skill",
            Self::Command => "command",
            Self::Hook => "hook",
            Self::Mcp => "mcp",
            Self::OutputStyle => "outputStyle",
            Self::Rule => "rule",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemScope {
    Managed,
    User,
    Project,
    Local,
    Plugin,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub wins: bool,
    pub winner_id: String,
    pub reason: String,
    pub other_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolkitItem {
    pub id: String,
    pub kind: ItemKind,
    pub scope: ItemScope,
    pub name: String,
    pub description: Option<String>,
    pub model: Option<String>,
    pub path: String,
    pub relative_path: String,
    pub plugin: Option<String>,
    pub frontmatter: Value,
    pub detail: Value,
    pub editable: bool,
    pub problem: Option<String>,
    pub conflict: Option<Conflict>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub marketplace: Option<String>,
    pub scope: String,
    pub version: Option<String>,
    pub path: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailablePlugin {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Marketplace {
    pub name: String,
    pub source: Value,
    pub path: String,
    pub last_updated: Option<String>,
    pub plugins: Vec<AvailablePlugin>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolkitScan {
    pub items: Vec<ToolkitItem>,
    pub plugins: Vec<PluginInfo>,
    pub marketplaces: Vec<Marketplace>,
}
