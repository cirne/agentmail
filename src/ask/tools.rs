//! Investigation-phase tools for `zmail ask` (metadata JSON strings for the model).
//! Mirrors [`src/ask/tools.ts`](../../../src/ask/tools.ts).

use base64::Engine;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

use crate::search::{search_with_meta, SearchOptions, SearchResult};
use crate::sync::parse_since_to_date;
use crate::thread_view::list_thread_messages;

/// Normalize message/thread id to angle-bracket form (see Node `normalizeMessageId`).
pub fn normalize_message_id(id: &str) -> String {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return id.to_string();
    }
    if trimmed.starts_with('<') && trimmed.ends_with('>') {
        trimmed.to_string()
    } else {
        format!("<{trimmed}>")
    }
}

fn parse_date_param(date_str: Option<&str>) -> Option<String> {
    let s = date_str?.trim();
    if s.is_empty() {
        return None;
    }
    if regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$").ok()?.is_match(s) {
        return Some(s.to_string());
    }
    parse_since_to_date(s).ok().or_else(|| Some(s.to_string()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MetadataSearchRow<'a> {
    message_id: &'a str,
    thread_id: &'a str,
    from_address: &'a str,
    from_name: Option<&'a str>,
    subject: &'a str,
    date: &'a str,
    snippet: &'a str,
    rank: f64,
}

fn to_metadata_results(results: &[SearchResult]) -> Vec<MetadataSearchRow<'_>> {
    results
        .iter()
        .enumerate()
        .map(|(index, r)| {
            let rank = if r.rank != 0.0 { r.rank } else { index as f64 };
            MetadataSearchRow {
                message_id: &r.message_id,
                thread_id: &r.thread_id,
                from_address: &r.from_address,
                from_name: r.from_name.as_deref(),
                subject: &r.subject,
                date: &r.date,
                snippet: &r.snippet,
                rank,
            }
        })
        .collect()
}

fn add_search_hints(
    response: &mut serde_json::Map<String, Value>,
    total_matched: Option<i64>,
    result_count: usize,
    limit: usize,
) {
    let Some(total) = total_matched else {
        return;
    };
    if total == 0 {
        response.insert(
            "hint".into(),
            json!("No results found. Try different query terms, synonyms, or related keywords."),
        );
    } else if total > (limit as i64) * 2 {
        response.insert(
            "hint".into(),
            json!(format!(
                "Found {total} total matches but only returned {result_count}. Consider increasing the limit or trying more specific query terms."
            )),
        );
    } else if total > limit as i64 {
        response.insert(
            "hint".into(),
            json!(format!(
                "Found {total} total matches. Increase limit to see more results."
            )),
        );
    }
}

fn check_result_diversity(
    response: &mut serde_json::Map<String, Value>,
    metadata: &[MetadataSearchRow<'_>],
) {
    if metadata.len() <= 5 {
        return;
    }
    let mut sender_counts: std::collections::HashMap<&str, usize> =
        std::collections::HashMap::new();
    for r in metadata {
        *sender_counts.entry(r.from_address).or_insert(0) += 1;
    }
    let max_sender = sender_counts.values().copied().max().unwrap_or(0);
    if max_sender as f64 / metadata.len() as f64 > 0.8 {
        let top_sender = sender_counts
            .into_iter()
            .max_by_key(|(_, c)| *c)
            .map(|(a, _)| a)
            .unwrap_or("");
        let extra = format!(
            " Most results are from {top_sender}. Consider searching with 'fromAddress' filter or trying different query terms for broader coverage."
        );
        let hint = response
            .get("hint")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        response.insert("hint".into(), json!(hint + &extra));
    }
}

fn check_enough_context(
    response: &mut serde_json::Map<String, Value>,
    metadata: &[MetadataSearchRow<'_>],
) {
    if metadata.len() < 20 {
        return;
    }
    let unique_senders: std::collections::HashSet<&str> =
        metadata.iter().map(|r| r.from_address).collect();
    if unique_senders.len() >= 3 || metadata.len() >= 50 {
        response.insert("hasEnoughContext".into(), json!(true));
    }
}

fn check_search_broadness(
    response: &mut serde_json::Map<String, Value>,
    metadata: &[MetadataSearchRow<'_>],
) {
    if metadata.len() < 50 {
        return;
    }
    let ranks: Vec<f64> = metadata
        .iter()
        .map(|r| r.rank)
        .filter(|x| *x > 0.0)
        .collect();
    if ranks.is_empty() {
        return;
    }
    let sum: f64 = ranks.iter().sum();
    let avg = sum / ranks.len() as f64;
    let max_rank = ranks.iter().copied().fold(0.0f64, f64::max);
    if avg > 10.0 || max_rank > 20.0 {
        let hint = response
            .get("hint")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let extra = format!(
            " Search returned many results but some have low relevance (average rank: {avg:.1}). Consider refining your query with more specific terms or filters."
        );
        response.insert("hint".into(), json!(hint + &extra));
    }
}

/// `search` tool — metadata-only results + hints (aligned with Node `executeSearchTool`).
/// `includeThreads` is accepted but ignored until Rust `search_with_meta` supports thread payloads (see RUST_PORT.md).
pub fn execute_search_tool(
    conn: &Connection,
    owner_address: Option<&str>,
    args: &serde_json::Map<String, Value>,
) -> rusqlite::Result<String> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(50);
    let from_address = args
        .get("fromAddress")
        .and_then(|v| v.as_str())
        .map(String::from);
    let to_address = args
        .get("toAddress")
        .and_then(|v| v.as_str())
        .map(String::from);
    let subject = args
        .get("subject")
        .and_then(|v| v.as_str())
        .map(String::from);
    let after_date = parse_date_param(args.get("afterDate").and_then(|v| v.as_str()));
    let before_date = parse_date_param(args.get("beforeDate").and_then(|v| v.as_str()));
    let filter_or = args
        .get("filterOr")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let include_noise = args
        .get("includeNoise")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let opts = SearchOptions {
        query: Some(query),
        limit: Some(limit),
        offset: 0,
        from_address,
        to_address,
        subject,
        after_date,
        before_date,
        filter_or,
        include_noise,
        owner_address: owner_address.map(String::from),
    };

    let set = search_with_meta(conn, &opts)?;
    let metadata = to_metadata_results(&set.results);
    let mut response = serde_json::Map::new();
    response.insert(
        "results".into(),
        serde_json::to_value(&metadata).unwrap_or(json!([])),
    );
    response.insert("totalMatched".into(), json!(set.total_matched));

    let result_count = metadata.len();
    add_search_hints(&mut response, set.total_matched, result_count, limit);
    check_result_diversity(&mut response, &metadata);
    check_enough_context(&mut response, &metadata);
    check_search_broadness(&mut response, &metadata);

    Ok(Value::Object(response).to_string())
}

/// `get_thread_headers` tool.
pub fn execute_get_thread_headers_tool(
    conn: &Connection,
    args: &serde_json::Map<String, Value>,
) -> rusqlite::Result<String> {
    let thread_id = args.get("threadId").and_then(|v| v.as_str()).unwrap_or("");
    let normalized = normalize_message_id(thread_id);
    let rows = list_thread_messages(conn, &normalized)?;
    if rows.is_empty() {
        return Ok(json!({ "error": "Thread not found", "threadId": normalized }).to_string());
    }
    let messages: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "messageId": r.message_id,
                "fromAddress": r.from_address,
                "fromName": r.from_name,
                "subject": r.subject,
                "date": r.date,
            })
        })
        .collect();
    Ok(json!({
        "threadId": normalized,
        "messages": messages,
    })
    .to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GetMessageAttachment {
    id: i64,
    filename: String,
    #[serde(rename = "mimeType")]
    mime_type: String,
    size: i64,
    extracted: bool,
}

/// `get_message` tool — lean message JSON for investigation (body truncated).
#[allow(clippy::type_complexity)]
pub fn execute_get_message_tool(
    conn: &Connection,
    data_dir: &std::path::Path,
    args: &serde_json::Map<String, Value>,
) -> rusqlite::Result<String> {
    let message_id =
        normalize_message_id(args.get("messageId").and_then(|v| v.as_str()).unwrap_or(""));
    let detail = args
        .get("detail")
        .and_then(|v| v.as_str())
        .unwrap_or("full");
    let max_body_chars = args
        .get("maxBodyChars")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(2000);
    let raw = args.get("raw").and_then(|v| v.as_bool()).unwrap_or(false);

    let row: Option<(String, String, String, Option<String>, String, String, String, String)> =
        conn.query_row(
            "SELECT message_id, thread_id, from_address, from_name, subject, date, body_text, raw_path FROM messages WHERE message_id = ?1",
            [&message_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            },
        )
        .optional()?;

    let Some((mid, thread_id, from_address, from_name, subject, date, body_text, _raw_path)) = row
    else {
        return Ok(json!({ "error": format!("Message {message_id} not found") }).to_string());
    };

    let atts = crate::attachments::list_attachments_for_message(conn, &mid)?;
    let attachments: Vec<GetMessageAttachment> = atts
        .iter()
        .map(|a| GetMessageAttachment {
            id: a.id,
            filename: a.filename.clone(),
            mime_type: a.mime_type.clone(),
            size: a.size,
            extracted: a.extracted,
        })
        .collect();

    if raw || detail == "raw" {
        let bytes = match crate::read_message_bytes(conn, &mid, data_dir)? {
            Ok(b) => b,
            Err(e) => {
                return Ok(json!({
                    "error": format!("read raw: {e}"),
                    "messageId": mid,
                })
                .to_string());
            }
        };
        let b64 = Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
        return Ok(json!({
            "messageId": mid,
            "threadId": thread_id,
            "fromAddress": from_address,
            "fromName": from_name,
            "subject": subject,
            "date": date,
            "rawBase64": b64,
            "attachments": attachments,
        })
        .to_string());
    }

    let body_for_out = if detail == "summary" {
        body_text.chars().take(200).collect::<String>()
    } else {
        body_text.chars().take(max_body_chars).collect::<String>()
    };

    Ok(json!({
        "messageId": mid,
        "threadId": thread_id,
        "fromAddress": from_address,
        "fromName": from_name,
        "subject": subject,
        "date": date,
        "content": { "markdown": body_for_out },
        "attachments": attachments,
    })
    .to_string())
}

/// Dispatch investigation tools (Phase 1).
pub fn execute_nano_tool(
    conn: &Connection,
    data_dir: &std::path::Path,
    owner_address: Option<&str>,
    name: &str,
    args: &serde_json::Map<String, Value>,
) -> rusqlite::Result<String> {
    match name {
        "search" => execute_search_tool(conn, owner_address, args),
        "get_thread_headers" => execute_get_thread_headers_tool(conn, args),
        "get_message" => execute_get_message_tool(conn, data_dir, args),
        _ => Ok(json!({ "error": format!("Unknown tool: {name}") }).to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::apply_schema;
    use rusqlite::Connection;

    fn empty_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        apply_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn normalize_id_wraps() {
        assert_eq!(normalize_message_id("foo"), "<foo>");
        assert_eq!(normalize_message_id("<foo>"), "<foo>");
    }

    #[test]
    fn search_empty_db_returns_results_array() {
        let conn = empty_db();
        let args = serde_json::Map::new();
        let s = execute_search_tool(&conn, None, &args).unwrap();
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["results"], json!([]));
    }
}
