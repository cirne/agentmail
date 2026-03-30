//! Slim vs full JSON rows (`src/search/search-json-format.ts`).

use serde_json::{json, Value};

use super::types::SearchResult;

/// Above this many results, `auto` chooses slim.
pub const SEARCH_AUTO_SLIM_THRESHOLD: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchJsonFormat {
    Slim,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchResultFormatPreference {
    Auto,
    Full,
    Slim,
}

pub fn resolve_search_json_format(
    result_count: usize,
    preference: SearchResultFormatPreference,
    allow_auto_slim: bool,
) -> SearchJsonFormat {
    match preference {
        SearchResultFormatPreference::Slim => SearchJsonFormat::Slim,
        SearchResultFormatPreference::Full => SearchJsonFormat::Full,
        SearchResultFormatPreference::Auto => {
            if !allow_auto_slim {
                SearchJsonFormat::Full
            } else if result_count > SEARCH_AUTO_SLIM_THRESHOLD {
                SearchJsonFormat::Slim
            } else {
                SearchJsonFormat::Full
            }
        }
    }
}

/// Slim row: messageId, subject, fromName?, date (no attachments in Rust search yet).
pub fn search_result_to_slim_json_row(r: &SearchResult) -> Value {
    let mut out = serde_json::Map::new();
    out.insert("messageId".into(), json!(r.message_id));
    out.insert("subject".into(), json!(r.subject));
    out.insert("date".into(), json!(r.date));
    if let Some(ref n) = r.from_name {
        if !n.is_empty() {
            out.insert("fromName".into(), json!(n));
        }
    }
    Value::Object(out)
}
