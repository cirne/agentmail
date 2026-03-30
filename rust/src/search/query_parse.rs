//! Inline operators (mirrors `src/search/query-parse.ts`).

use crate::parse_since_to_date;
use regex::Regex;
use std::sync::LazyLock;

static RE_FROM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bfrom:(\S+)").unwrap());
static RE_TO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bto:(\S+)").unwrap());
static RE_SUBJ: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bsubject:(\S+)").unwrap());
static RE_AFTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bafter:(\S+)").unwrap());
static RE_BEFORE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bbefore:(\S+)").unwrap());
static RE_ISO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap());

#[derive(Debug, Default, Clone)]
pub struct ParsedSearchQuery {
    pub query: String,
    pub from_address: Option<String>,
    pub to_address: Option<String>,
    pub subject: Option<String>,
    pub after_date: Option<String>,
    pub before_date: Option<String>,
    pub filter_or: Option<bool>,
}

fn try_parse_date(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if RE_ISO.is_match(trimmed) {
        return Some(trimmed.to_string());
    }
    parse_since_to_date(trimmed).ok()
}

/// Strip `key:value` operators; remainder is FTS query.
pub fn parse_search_query(raw: &str) -> ParsedSearchQuery {
    let mut result = ParsedSearchQuery::default();
    let raw = raw.trim();
    if raw.is_empty() {
        return result;
    }

    if let Some(c) = RE_FROM.captures(raw) {
        result.from_address = Some(c.get(1).unwrap().as_str().to_string());
    }
    if let Some(c) = RE_TO.captures(raw) {
        result.to_address = Some(c.get(1).unwrap().as_str().to_string());
    }
    if let Some(c) = RE_SUBJ.captures(raw) {
        result.subject = Some(c.get(1).unwrap().as_str().to_string());
    }
    if let Some(c) = RE_AFTER.captures(raw) {
        if let Some(d) = try_parse_date(c.get(1).unwrap().as_str()) {
            result.after_date = Some(d);
        }
    }
    if let Some(c) = RE_BEFORE.captures(raw) {
        if let Some(d) = try_parse_date(c.get(1).unwrap().as_str()) {
            result.before_date = Some(d);
        }
    }

    let mut stripped = raw.to_string();
    for re in [&*RE_FROM, &*RE_TO, &*RE_SUBJ, &*RE_AFTER, &*RE_BEFORE] {
        stripped = re.replace_all(&stripped, "").trim().to_string();
    }

    let mut query = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
    let re_only = Regex::new(r"^(OR|AND)(\s+(OR|AND))*$").unwrap();
    let filters_n = [
        result.from_address.as_ref(),
        result.to_address.as_ref(),
        result.subject.as_ref(),
        result.after_date.as_ref(),
        result.before_date.as_ref(),
    ]
    .iter()
    .filter(|o| o.is_some())
    .count();
    let tq = query.trim();
    if re_only.is_match(tq) && filters_n > 1 {
        result.filter_or = Some(tq.to_uppercase().starts_with("OR"));
        query.clear();
    } else if re_only.is_match(tq) {
        query.clear();
    } else {
        let re_trim = Regex::new(r"(?i)^\s*(OR|AND)\s+|\s+(OR|AND)\s*$").unwrap();
        query = re_trim.replace_all(&query, "").trim().to_string();
    }
    query = query
        .replace(" or ", " OR ")
        .replace(" and ", " AND ");
    result.query = query;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input() {
        let r = parse_search_query("");
        assert_eq!(r.query, "");
        assert!(r.from_address.is_none());
    }

    #[test]
    fn from_only() {
        let r = parse_search_query("from:alice@example.com");
        assert_eq!(r.from_address.as_deref(), Some("alice@example.com"));
        assert_eq!(r.query, "");
    }

    #[test]
    fn from_with_remainder() {
        let r = parse_search_query("from:alice@example.com invoice");
        assert_eq!(r.from_address.as_deref(), Some("alice@example.com"));
        assert_eq!(r.query, "invoice");
    }

    #[test]
    fn to_operator() {
        let r = parse_search_query("to:bob@example.com");
        assert_eq!(r.to_address.as_deref(), Some("bob@example.com"));
        assert_eq!(r.query, "");
    }

    #[test]
    fn subject_operator() {
        let r = parse_search_query("subject:meeting");
        assert_eq!(r.subject.as_deref(), Some("meeting"));
        assert_eq!(r.query, "");
    }

    #[test]
    fn after_iso() {
        let r = parse_search_query("after:2024-01-01");
        assert_eq!(r.after_date.as_deref(), Some("2024-01-01"));
        assert_eq!(r.query, "");
    }

    #[test]
    fn after_relative_yyyy_mm_dd() {
        let r = parse_search_query("after:7d");
        assert!(r.after_date.is_some());
        let d = r.after_date.unwrap();
        assert!(regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$")
            .unwrap()
            .is_match(&d));
    }

    #[test]
    fn before_iso() {
        let r = parse_search_query("before:2024-12-31");
        assert_eq!(r.before_date.as_deref(), Some("2024-12-31"));
        assert_eq!(r.query, "");
    }

    #[test]
    fn multiple_operators() {
        let r = parse_search_query("from:alice@example.com subject:invoice after:7d");
        assert_eq!(r.from_address.as_deref(), Some("alice@example.com"));
        assert_eq!(r.subject.as_deref(), Some("invoice"));
        assert!(r.after_date.is_some());
        assert_eq!(r.query, "");
    }

    #[test]
    fn remainder_with_or() {
        let r = parse_search_query("from:alice@example.com invoice OR receipt");
        assert_eq!(r.from_address.as_deref(), Some("alice@example.com"));
        assert_eq!(r.query, "invoice OR receipt");
    }

    #[test]
    fn normalizes_or_and() {
        let r = parse_search_query("invoice or receipt");
        assert_eq!(r.query, "invoice OR receipt");
        let r2 = parse_search_query("invoice and receipt");
        assert_eq!(r2.query, "invoice AND receipt");
    }

    #[test]
    fn operator_in_middle() {
        let r = parse_search_query("invoice from:alice@example.com receipt");
        assert_eq!(r.from_address.as_deref(), Some("alice@example.com"));
        assert_eq!(r.query, "invoice receipt");
    }

    #[test]
    fn ignores_invalid_after_date() {
        let r = parse_search_query("after:invalid-date");
        assert!(r.after_date.is_none());
    }

    #[test]
    fn complex_all_operators() {
        let r = parse_search_query(
            "from:alice@example.com to:bob@example.com subject:meeting after:7d before:2024-12-31 invoice OR receipt",
        );
        assert_eq!(r.from_address.as_deref(), Some("alice@example.com"));
        assert_eq!(r.to_address.as_deref(), Some("bob@example.com"));
        assert_eq!(r.subject.as_deref(), Some("meeting"));
        assert!(r.after_date.is_some());
        assert_eq!(r.before_date.as_deref(), Some("2024-12-31"));
        assert_eq!(r.query, "invoice OR receipt");
    }

    #[test]
    fn text_only() {
        let r = parse_search_query("invoice receipt");
        assert_eq!(r.query, "invoice receipt");
        assert!(r.from_address.is_none());
    }

    #[test]
    fn whitespace_trimmed() {
        let r = parse_search_query("  from:alice@example.com  invoice  ");
        assert_eq!(r.from_address.as_deref(), Some("alice@example.com"));
        assert_eq!(r.query, "invoice");
    }

    #[test]
    fn filter_only_or_between_filters() {
        let r = parse_search_query("from:marcio OR to:marcio");
        assert_eq!(r.from_address.as_deref(), Some("marcio"));
        assert_eq!(r.to_address.as_deref(), Some("marcio"));
        assert_eq!(r.query, "");
        assert_eq!(r.filter_or, Some(true));
    }

    #[test]
    fn filter_only_and_between_filters() {
        let r = parse_search_query("from:alice AND to:bob");
        assert_eq!(r.from_address.as_deref(), Some("alice"));
        assert_eq!(r.to_address.as_deref(), Some("bob"));
        assert_eq!(r.query, "");
        assert_eq!(r.filter_or, Some(false));
    }

    #[test]
    fn or_with_text_terms_keeps_query() {
        let r = parse_search_query("from:alice invoice OR receipt");
        assert_eq!(r.from_address.as_deref(), Some("alice"));
        assert_eq!(r.query, "invoice OR receipt");
    }
}
