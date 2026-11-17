use std::collections::HashMap;

/// One saved variable: its name as stored, its value, and whether `%NAME%` references must be expanded.
#[derive(Debug, Clone, PartialEq)]
pub struct Saved {
    pub name: String,
    pub value: String,
    pub expand: bool,
}

fn path_key(name: &str) -> bool {
    name.eq_ignore_ascii_case("PATH")
}

/// Replaces `%NAME%` with values already known, case-insensitively, leaving unknown references as they are.
pub fn expand(value: &str, known: &HashMap<String, (String, String)>) -> String {
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        output.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match known.get(&name.to_uppercase()) {
                    Some((_, resolved)) => output.push_str(resolved),
                    None => output.push_str(&rest[start..start + end + 2]),
                }
                rest = &after[end + 1..];
            }
            _ => {
                output.push('%');
                rest = after;
            }
        }
    }
    output.push_str(rest);
    output
}

fn split_path(value: &str) -> Vec<String> {
    value.split(';').map(str::trim).filter(|entry| !entry.is_empty()).map(str::to_owned).collect()
}

/// The environment a newly started Windows program would get, built the way Explorer builds it:
/// inherited variables, then saved machine variables, then saved user variables on top. PATH is the
/// machine entries, then the user entries, then any inherited entries not already present.
pub fn merge(inherited: &[(String, String)], machine: &[Saved], user: &[Saved]) -> Vec<(String, String)> {
    let mut known: HashMap<String, (String, String)> = inherited.iter().map(|(name, value)| (name.to_uppercase(), (name.clone(), value.clone()))).collect();
    let inherited_path = known.get("PATH").map(|(_, value)| value.clone()).unwrap_or_default();
    let mut saved_path: Vec<String> = Vec::new();
    for layer in [machine, user] {
        for saved in layer.iter().filter(|saved| !path_key(&saved.name)) {
            let value = if saved.expand { expand(&saved.value, &known) } else { saved.value.clone() };
            known.insert(saved.name.to_uppercase(), (saved.name.clone(), value));
        }
    }
    for layer in [machine, user] {
        for saved in layer.iter().filter(|saved| path_key(&saved.name)) {
            let value = if saved.expand { expand(&saved.value, &known) } else { saved.value.clone() };
            saved_path.extend(split_path(&value));
        }
    }
    if !saved_path.is_empty() {
        let mut entries: Vec<String> = Vec::new();
        for entry in saved_path.into_iter().chain(split_path(&inherited_path)) {
            if !entries.iter().any(|existing| existing.eq_ignore_ascii_case(&entry)) {
                entries.push(entry);
            }
        }
        let name = known.get("PATH").map_or_else(|| "Path".to_owned(), |(name, _)| name.clone());
        known.insert("PATH".into(), (name, entries.join(";")));
    }
    let mut merged: Vec<(String, String)> = known.into_values().collect();
    merged.sort();
    merged
}

#[cfg(windows)]
fn saved(hive: winreg::HKEY, key: &str) -> Vec<Saved> {
    use winreg::enums::REG_EXPAND_SZ;
    use winreg::types::FromRegValue;
    let Ok(key) = winreg::RegKey::predef(hive).open_subkey(key) else {
        return Vec::new();
    };
    key.enum_values()
        .filter_map(Result::ok)
        .filter_map(|(name, raw)| String::from_reg_value(&raw).ok().map(|value| Saved { name, value, expand: raw.vtype == REG_EXPAND_SZ }))
        .collect()
}

/// The current environment for child processes. On Windows the saved user and machine variables are
/// read again on every call, so a PATH or JAVA_HOME fixed after CuciCode started applies to the next
/// session, check or terminal without a restart, and a stale value inherited from the launching
/// terminal (for example an editor's JAVA_HOME) is replaced by the saved one.
pub fn current() -> Vec<(String, String)> {
    let inherited: Vec<(String, String)> = std::env::vars().collect();
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
        let machine = saved(HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment");
        let user = saved(HKEY_CURRENT_USER, "Environment");
        merge(&inherited, &machine, &user)
    }
    #[cfg(not(windows))]
    {
        inherited
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(name: &str, value: &str, expand: bool) -> Saved {
        Saved { name: name.into(), value: value.into(), expand }
    }

    fn get<'a>(merged: &'a [(String, String)], name: &str) -> &'a str {
        merged.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map_or("", |(_, value)| value.as_str())
    }

    #[test]
    fn expands_known_references_and_keeps_unknown_ones() {
        let known = HashMap::from([("USERPROFILE".to_owned(), ("USERPROFILE".to_owned(), r"C:\Users\me".to_owned()))]);
        assert_eq!(expand(r"%UserProfile%\bin;%NOPE%;50%", &known), r"C:\Users\me\bin;%NOPE%;50%");
    }

    #[test]
    fn saved_values_replace_a_stale_inherited_one_and_user_beats_machine() {
        let inherited = vec![("JAVA_HOME".to_owned(), r"C:\gone\jdk-25".to_owned()), ("TERM".to_owned(), "x".to_owned())];
        let merged = merge(&inherited, &[saved("JAVA_HOME", r"C:\jdk-17", false)], &[saved("JAVA_HOME", r"C:\jdk-21", false)]);
        assert_eq!(get(&merged, "JAVA_HOME"), r"C:\jdk-21");
        assert_eq!(get(&merged, "TERM"), "x");
    }

    #[test]
    fn path_is_machine_then_user_then_inherited_extras_without_duplicates() {
        let inherited = vec![("Path".to_owned(), r"C:\Windows;C:\repo\node_modules\.bin;c:\maven\bin".to_owned()), ("USERPROFILE".to_owned(), r"C:\Users\me".to_owned())];
        let merged = merge(&inherited, &[saved("Path", r"C:\Windows;C:\Windows\System32", true)], &[saved("Path", r"C:\Maven\bin;%USERPROFILE%\jdk\bin", true)]);
        assert_eq!(get(&merged, "PATH"), r"C:\Windows;C:\Windows\System32;C:\Maven\bin;C:\Users\me\jdk\bin;C:\repo\node_modules\.bin");
        assert_eq!(merged.iter().filter(|(key, _)| key.eq_ignore_ascii_case("PATH")).count(), 1);
    }

    #[test]
    fn without_saved_variables_the_inherited_environment_is_unchanged() {
        let inherited = vec![("Path".to_owned(), "a;b".to_owned())];
        assert_eq!(merge(&inherited, &[], &[]), inherited);
    }
}
