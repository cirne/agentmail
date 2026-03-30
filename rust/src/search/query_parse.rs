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
