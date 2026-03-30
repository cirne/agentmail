//! Nickname → canonical first name (`src/search/nicknames.ts` subset).

use std::collections::HashMap;
use std::sync::LazyLock;

static NICKNAMES: LazyLock<HashMap<&'static str, &'static str>> = LazyLock::new(|| {
    HashMap::from([
        ("bob", "robert"),
        ("rob", "robert"),
        ("bill", "william"),
        ("will", "william"),
        ("mike", "michael"),
        ("jim", "james"),
        ("jack", "john"),
        ("johnny", "john"),
        ("dave", "david"),
        ("chris", "christopher"),
        ("tom", "thomas"),
        ("dan", "daniel"),
        ("matt", "matthew"),
        ("andy", "andrew"),
        ("lew", "lewis"),
        ("lou", "lewis"),
    ])
});

pub fn canonical_first_name(name: &str) -> String {
    let lower = name.to_lowercase().trim().to_string();
    NICKNAMES
        .get(lower.as_str())
        .map(|s| (*s).to_string())
        .unwrap_or(lower)
}
