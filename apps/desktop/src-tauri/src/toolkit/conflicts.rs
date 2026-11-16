use std::collections::HashMap;

use super::model::{Conflict, ItemKind, ItemScope, ToolkitItem};

/// Lower rank wins. `None` means the kind has no name-based precedence.
fn rank(kind: ItemKind, scope: ItemScope) -> Option<u8> {
    use ItemScope::{Local, Managed, Plugin, Project, User};
    let order: &[ItemScope] = match kind {
        ItemKind::Agent | ItemKind::OutputStyle => &[Managed, Local, Project, User, Plugin],
        ItemKind::Skill | ItemKind::Command => &[Managed, User, Local, Project, Plugin],
        ItemKind::Mcp => &[Managed, Local, Project, User, Plugin],
        ItemKind::Hook | ItemKind::Rule => return None,
    };
    order.iter().position(|candidate| *candidate == scope).map(|position| position as u8)
}

fn reason(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Agent => "Agents with the same name: managed wins, then project, then user, then plugin.",
        ItemKind::OutputStyle => "Output styles with the same name: the project's wins over the user's.",
        ItemKind::Skill => "Skills with the same name: managed wins, then personal (user), then project.",
        ItemKind::Command => "Commands with the same name: assumed to follow skills (user before project); the docs do not state it.",
        ItemKind::Mcp => "MCP servers with the same name: local wins, then project, then user, then plugin. The whole entry is replaced, not merged.",
        ItemKind::Hook | ItemKind::Rule => "",
    }
}

const SKILL_OVER_COMMAND: &str = "A skill and a command share this name: the skill takes precedence.";

/// Marks items that share a name with another item of the same kind, and
/// commands that are shadowed by a skill.
pub fn annotate(items: &mut [ToolkitItem]) {
    let mut groups: HashMap<(ItemKind, String), Vec<usize>> = HashMap::new();
    for (index, item) in items.iter().enumerate() {
        if rank(item.kind, item.scope).is_some() {
            groups.entry((item.kind, item.name.clone())).or_default().push(index);
        }
    }
    let mut skill_by_name: HashMap<String, String> = HashMap::new();
    for ((kind, name), members) in &groups {
        let Some(winner) = members.iter().copied().min_by_key(|index| rank(items[*index].kind, items[*index].scope)) else {
            continue;
        };
        if *kind == ItemKind::Skill {
            skill_by_name.insert(name.clone(), items[winner].id.clone());
        }
        if members.len() < 2 {
            continue;
        }
        let winner_id = items[winner].id.clone();
        for index in members {
            let other_ids = members.iter().filter(|other| *other != index).map(|other| items[*other].id.clone()).collect();
            items[*index].conflict = Some(Conflict {
                wins: *index == winner,
                winner_id: winner_id.clone(),
                reason: reason(*kind).to_owned(),
                other_ids,
            });
        }
    }
    for item in items.iter_mut().filter(|item| item.kind == ItemKind::Command) {
        if let Some(skill_id) = skill_by_name.get(&item.name) {
            let mut other_ids = item.conflict.take().map(|conflict| conflict.other_ids).unwrap_or_default();
            other_ids.push(skill_id.clone());
            item.conflict = Some(Conflict { wins: false, winner_id: skill_id.clone(), reason: SKILL_OVER_COMMAND.to_owned(), other_ids });
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn item(kind: ItemKind, scope: ItemScope, name: &str) -> ToolkitItem {
        ToolkitItem {
            id: format!("{}:{scope:?}:{name}", kind.label()),
            kind,
            scope,
            name: name.to_owned(),
            description: None,
            model: None,
            path: String::new(),
            relative_path: String::new(),
            plugin: None,
            frontmatter: json!({}),
            detail: json!({}),
            editable: true,
            problem: None,
            conflict: None,
        }
    }

    fn winner(items: &[ToolkitItem], kind: ItemKind, name: &str) -> ItemScope {
        items.iter().find(|item| item.kind == kind && item.name == name && item.conflict.as_ref().is_some_and(|conflict| conflict.wins)).unwrap().scope
    }

    #[test]
    fn project_agent_beats_user_agent_but_user_skill_beats_project_skill() {
        let mut items = vec![
            item(ItemKind::Agent, ItemScope::User, "reviewer"),
            item(ItemKind::Agent, ItemScope::Project, "reviewer"),
            item(ItemKind::Skill, ItemScope::User, "deploy"),
            item(ItemKind::Skill, ItemScope::Project, "deploy"),
        ];
        annotate(&mut items);
        assert_eq!(winner(&items, ItemKind::Agent, "reviewer"), ItemScope::Project);
        assert_eq!(winner(&items, ItemKind::Skill, "deploy"), ItemScope::User);
        assert_eq!(items[0].conflict.as_ref().unwrap().other_ids, vec![items[1].id.clone()]);
    }

    #[test]
    fn local_mcp_server_beats_project_and_user() {
        let mut items = vec![
            item(ItemKind::Mcp, ItemScope::User, "github"),
            item(ItemKind::Mcp, ItemScope::Local, "github"),
            item(ItemKind::Mcp, ItemScope::Project, "github"),
        ];
        annotate(&mut items);
        assert_eq!(winner(&items, ItemKind::Mcp, "github"), ItemScope::Local);
        assert!(items.iter().all(|entry| entry.conflict.is_some()));
    }

    #[test]
    fn unique_names_hooks_and_rules_have_no_conflict() {
        let mut items = vec![
            item(ItemKind::Agent, ItemScope::User, "a"),
            item(ItemKind::Agent, ItemScope::Project, "b"),
            item(ItemKind::Hook, ItemScope::User, "Stop"),
            item(ItemKind::Hook, ItemScope::Project, "Stop"),
            item(ItemKind::Rule, ItemScope::User, "CLAUDE.md"),
            item(ItemKind::Rule, ItemScope::Project, "CLAUDE.md"),
        ];
        annotate(&mut items);
        assert!(items.iter().all(|entry| entry.conflict.is_none()));
    }

    #[test]
    fn a_command_is_shadowed_by_a_skill_with_the_same_name() {
        let mut items = vec![item(ItemKind::Command, ItemScope::Project, "ship"), item(ItemKind::Skill, ItemScope::User, "ship")];
        annotate(&mut items);
        let conflict = items[0].conflict.as_ref().unwrap();
        assert!(!conflict.wins);
        assert_eq!(conflict.winner_id, items[1].id);
        assert!(conflict.reason.contains("skill takes precedence"));
        assert!(items[1].conflict.is_none());
    }
}
