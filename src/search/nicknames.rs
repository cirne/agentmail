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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_nicknames() {
        assert_eq!(canonical_first_name("lew"), "lewis");
        assert_eq!(canonical_first_name("bob"), "robert");
        assert_eq!(canonical_first_name("bill"), "william");
        assert_eq!(canonical_first_name("matt"), "matthew");
    }

    #[test]
    fn unknown_lowercase() {
        assert_eq!(canonical_first_name("kirsten"), "kirsten");
        assert_eq!(canonical_first_name("donna"), "donna");
        assert_eq!(canonical_first_name("geoff"), "geoff");
    }

    #[test]
    fn case_insensitive() {
        assert_eq!(canonical_first_name("LEW"), "lewis");
        assert_eq!(canonical_first_name("Bob"), "robert");
    }

    #[test]
    fn trims_whitespace() {
        assert_eq!(canonical_first_name("  lew  "), "lewis");
    }
}
