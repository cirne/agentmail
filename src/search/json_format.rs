//! Slim vs full JSON rows (`src/search/search-json-format.ts`).

use serde_json::{json, Value};

use crate::ids::message_id_for_json_output;

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
    out.insert(
        "messageId".into(),
        json!(message_id_for_json_output(&r.message_id)),
    );
    out.insert("subject".into(), json!(r.subject));
    out.insert("date".into(), json!(r.date));
    if let Some(ref n) = r.from_name {
        if !n.is_empty() {
            out.insert("fromName".into(), json!(n));
        }
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::types::SearchResult;

    #[test]
    fn resolve_auto_slim_above_threshold() {
        assert_eq!(
            resolve_search_json_format(
                SEARCH_AUTO_SLIM_THRESHOLD + 1,
                SearchResultFormatPreference::Auto,
                true,
            ),
            SearchJsonFormat::Slim
        );
    }

    #[test]
    fn resolve_auto_full_at_threshold() {
        assert_eq!(
            resolve_search_json_format(
                SEARCH_AUTO_SLIM_THRESHOLD,
                SearchResultFormatPreference::Auto,
                true,
            ),
            SearchJsonFormat::Full
        );
    }

    #[test]
    fn resolve_auto_never_slim_when_disabled() {
        assert_eq!(
            resolve_search_json_format(100, SearchResultFormatPreference::Auto, false,),
            SearchJsonFormat::Full
        );
    }

    #[test]
    fn slim_row_shape() {
        let r = SearchResult {
            message_id: "<a@b>".into(),
            thread_id: "<a@b>".into(),
            from_address: "x@y.com".into(),
            from_name: Some("X".into()),
            subject: "Hi".into(),
            date: "2026-01-01T00:00:00.000Z".into(),
            snippet: "snip".into(),
            body_preview: "p".into(),
            rank: -1.0,
        };
        let v = search_result_to_slim_json_row(&r);
        assert_eq!(v["messageId"], "a@b");
        assert_eq!(v["subject"], "Hi");
        assert_eq!(v["date"], "2026-01-01T00:00:00.000Z");
        assert_eq!(v["fromName"], "X");
        assert!(v.get("bodyPreview").is_none());
    }

    #[test]
    fn slim_row_omits_empty_from_name() {
        let r = SearchResult {
            message_id: "m".into(),
            thread_id: "m".into(),
            from_address: "a@b".into(),
            from_name: Some(String::new()),
            subject: "S".into(),
            date: "d".into(),
            snippet: "".into(),
            body_preview: "".into(),
            rank: 0.0,
        };
        let v = search_result_to_slim_json_row(&r);
        assert!(v.get("fromName").is_none());
    }
}
