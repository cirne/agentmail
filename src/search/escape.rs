//! FTS5 query escaping and OR conversion (mirrors `src/search/index.ts`).

use regex::Regex;
use std::sync::LazyLock;

static RE_OPS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(OR|AND)\b").unwrap());
static RE_PROBLEMATIC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\[\]{}()]").unwrap());
static RE_OR_SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+OR\s+").unwrap());
static RE_OP_SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+(OR|AND)\s+").unwrap());
static RE_QUOTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""([^"]+)""#).unwrap());

pub fn escape_fts5_query(query: &str) -> String {
    let has_operators = RE_OPS.is_match(query);
    let has_problematic = RE_PROBLEMATIC.is_match(query);

    if !has_operators && (query.contains('.') || has_problematic) {
        if query.contains(" OR ") {
            let parts: Vec<&str> = RE_OR_SPLIT.split(query).collect();
            let mut escaped_parts = Vec::new();
            for part in parts {
                let p = part.trim();
                if p.contains('.') || RE_PROBLEMATIC.is_match(p) {
                    escaped_parts.push(format!("\"{}\"", p.replace('"', "\"\"")));
                } else {
                    escaped_parts.push(p.to_string());
                }
            }
            return escaped_parts.join(" OR ");
        }
        return format!("\"{}\"", query.replace('"', "\"\""));
    }

    if has_operators && (query.contains('.') || has_problematic) {
        let parts: Vec<&str> = RE_OP_SPLIT.split(query).collect();
        let mut escaped_parts = Vec::new();
        for part in parts {
            let p = part.trim();
            if p.eq_ignore_ascii_case("or") || p.eq_ignore_ascii_case("and") {
                escaped_parts.push(p.to_uppercase());
            } else if p.contains('.') || RE_PROBLEMATIC.is_match(p) {
                escaped_parts.push(format!("\"{}\"", p.replace('"', "\"\"")));
            } else {
                escaped_parts.push(p.to_string());
            }
        }
        return escaped_parts.join(" ");
    }

    query.to_string()
}

pub fn convert_to_or_query(query: &str) -> String {
    if RE_OPS.is_match(query) {
        return escape_fts5_query(query);
    }

    let mut quoted: Vec<String> = Vec::new();
    let mut replaced = String::new();
    let mut last_end = 0;
    for cap in RE_QUOTED.captures_iter(query) {
        let full = cap.get(0).unwrap();
        replaced.push_str(&query[last_end..full.start()]);
        let idx = quoted.len();
        quoted.push(cap.get(1).unwrap().as_str().to_string());
        replaced.push_str(&format!("___Q{idx}___"));
        last_end = full.end();
    }
    replaced.push_str(&query[last_end..]);

    let parts: Vec<&str> = replaced
        .split_whitespace()
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() <= 1 {
        return escape_fts5_query(query);
    }

    let re_ph = Regex::new(r"^___Q(\d+)___$").unwrap();
    let mut or_parts = Vec::new();
    for part in parts {
        if let Some(cap) = re_ph.captures(part) {
            let i: usize = cap.get(1).unwrap().as_str().parse().unwrap();
            let phrase = &quoted[i];
            or_parts.push(format!("\"{}\"", phrase.replace('"', "\"\"")));
        } else {
            or_parts.push(part.to_string());
        }
    }
    escape_fts5_query(&or_parts.join(" OR "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_plain_unchanged() {
        assert_eq!(escape_fts5_query("invoice"), "invoice");
    }

    #[test]
    fn escape_dots_wrap_phrase() {
        assert_eq!(
            escape_fts5_query("user@mail.example.com"),
            "\"user@mail.example.com\""
        );
    }

    #[test]
    fn escape_brackets() {
        assert_eq!(escape_fts5_query("foo[bar]"), "\"foo[bar]\"");
    }

    #[test]
    fn escape_or_splits_parts_with_dots() {
        // Operator token is consumed by the split; joined parts are space-separated quoted segments.
        assert_eq!(escape_fts5_query("a.com OR b.com"), "\"a.com\" \"b.com\"");
    }

    #[test]
    fn convert_words_to_or() {
        let q = convert_to_or_query("advisory meeting");
        assert!(q.contains(" OR "));
        assert!(q.contains("advisory") && q.contains("meeting"));
    }

    #[test]
    fn convert_respects_quoted_phrase() {
        let q = convert_to_or_query(r#""exact phrase" extra"#);
        assert!(q.contains("exact phrase"));
    }

    #[test]
    fn lowercase_or_not_treated_as_operator() {
        // RE_OPS only matches uppercase OR/AND; lowercase "or" is not split.
        let q = escape_fts5_query("foo.com or bar.com");
        assert!(q.starts_with('"') && q.contains("foo.com or bar.com"));
    }
}
