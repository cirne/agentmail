//! Draft list JSON payload (`node/src/send/draft-list-json.ts`).

use serde_json::{json, Value};

use crate::search::{resolve_search_json_format, SearchJsonFormat, SearchResultFormatPreference};

use super::draft_store::{draft_list_slim_hint, DraftListRow};

fn row_to_slim_json(r: &DraftListRow) -> Value {
    let abs = r.path.canonicalize().unwrap_or_else(|_| r.path.clone());
    let mut m = serde_json::Map::new();
    m.insert("id".into(), json!(r.id));
    m.insert("path".into(), json!(abs.to_string_lossy()));
    m.insert("kind".into(), json!(r.kind));
    if r.subject.as_ref().is_some_and(|s| !s.is_empty()) {
        m.insert("subject".into(), json!(r.subject));
    }
    Value::Object(m)
}

fn row_to_full_json(r: &DraftListRow) -> Value {
    let mut v = row_to_slim_json(r);
    if let Value::Object(ref mut o) = v {
        o.insert("bodyPreview".into(), json!(r.body_preview));
    }
    v
}

pub fn build_draft_list_json_payload(
    rows: &[DraftListRow],
    preference: SearchResultFormatPreference,
) -> Value {
    let format = resolve_search_json_format(rows.len(), preference, true);
    let drafts: Vec<Value> = match format {
        SearchJsonFormat::Slim => rows.iter().map(row_to_slim_json).collect(),
        SearchJsonFormat::Full => rows.iter().map(row_to_full_json).collect(),
    };
    let format_str = match format {
        SearchJsonFormat::Slim => "slim",
        SearchJsonFormat::Full => "full",
    };
    let mut out = json!({
        "drafts": drafts,
        "returned": drafts.len(),
        "format": format_str,
    });
    if matches!(format, SearchJsonFormat::Slim) && !rows.is_empty() {
        out["hint"] = json!(draft_list_slim_hint());
    }
    out
}
