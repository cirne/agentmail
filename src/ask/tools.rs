//! Investigation-phase tools for `zmail ask` (metadata JSON strings for the model).
//! Mirrors [`src/ask/tools.ts`](../../../src/ask/tools.ts).

use base64::Engine;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

use crate::ids::{message_id_for_json_output, resolve_message_id, resolve_thread_id};
use crate::mail_category::parse_category_list;
use crate::search::{search_with_meta, SearchOptions, SearchResult};
use crate::sync::{parse_read_full, parse_since_to_date};
use crate::thread_view::list_thread_messages;

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
    #[serde(serialize_with = "crate::ids::serialize_borrowed_str_id_for_json")]
    message_id: &'a str,
    #[serde(serialize_with = "crate::ids::serialize_borrowed_str_id_for_json")]
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

/// `search` tool — metadata-only results + optional thread payloads + hints.
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
    let include_all = args
        .get("includeAll")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let categories = args
        .get("category")
        .and_then(|v| v.as_str())
        .map(parse_category_list)
        .unwrap_or_default();
    let include_threads = args
        .get("includeThreads")
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
        include_all,
        categories,
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
    if include_threads {
        let mut thread_ids = std::collections::HashSet::new();
        let mut threads = Vec::new();
        for row in &set.results {
            if thread_ids.insert(row.thread_id.clone()) {
                let rows = list_thread_messages(conn, &row.thread_id)?;
                let messages: Vec<Value> = rows
                    .iter()
                    .map(|thread_row| {
                        json!({
                            "messageId": message_id_for_json_output(&thread_row.message_id),
                            "fromAddress": thread_row.from_address,
                            "fromName": thread_row.from_name,
                            "subject": thread_row.subject,
                            "date": thread_row.date,
                        })
                    })
                    .collect();
                threads.push(json!({
                    "threadId": message_id_for_json_output(&row.thread_id),
                    "messages": messages,
                }));
            }
        }
        response.insert("threads".into(), json!(threads));
    }

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
    let Some(normalized) = resolve_thread_id(conn, thread_id)? else {
        return Ok(
            json!({ "error": "Thread not found", "threadId": message_id_for_json_output(thread_id) })
                .to_string(),
        );
    };
    let rows = list_thread_messages(conn, &normalized)?;
    if rows.is_empty() {
        return Ok(
            json!({ "error": "Thread not found", "threadId": message_id_for_json_output(&normalized) })
                .to_string(),
        );
    }
    let messages: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "messageId": message_id_for_json_output(&r.message_id),
                "fromAddress": r.from_address,
                "fromName": r.from_name,
                "subject": r.subject,
                "date": r.date,
            })
        })
        .collect();
    Ok(json!({
        "threadId": message_id_for_json_output(&normalized),
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
    let arg = args.get("messageId").and_then(|v| v.as_str()).unwrap_or("");
    let Some(message_id) = resolve_message_id(conn, arg)? else {
        return Ok(json!({ "error": format!("Message {arg} not found") }).to_string());
    };
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

    let bytes_opt = match crate::read_message_bytes(conn, &mid, data_dir)? {
        Ok(b) => Some(b),
        Err(e) => {
            if raw || detail == "raw" {
                return Ok(json!({
                    "error": format!("read raw: {e}"),
                    "messageId": message_id_for_json_output(&mid),
                })
                .to_string());
            }
            None
        }
    };
    let parsed_opt = bytes_opt.as_ref().map(|b| parse_read_full(b));

    if raw || detail == "raw" {
        let bytes = bytes_opt.expect("raw implies bytes read ok");
        let b64 = Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
        return Ok(json!({
            "messageId": message_id_for_json_output(&mid),
            "threadId": message_id_for_json_output(&thread_id),
            "fromAddress": from_address,
            "fromName": from_name,
            "subject": subject,
            "date": date,
            "rawBase64": b64,
            "to": parsed_opt.as_ref().map_or(json!([]), |p| json!(p.to)),
            "cc": parsed_opt.as_ref().map_or(json!([]), |p| json!(p.cc)),
            "bcc": parsed_opt.as_ref().map_or(json!([]), |p| json!(p.bcc)),
            "replyTo": parsed_opt.as_ref().map_or(json!([]), |p| json!(p.reply_to)),
            "inReplyTo": parsed_opt.as_ref().and_then(|p| p.in_reply_to.as_ref().map(|s| message_id_for_json_output(s))),
            "references": parsed_opt.as_ref().map_or(json!([]), |p| {
                let refs: Vec<String> =
                    p.references.iter().map(|s| message_id_for_json_output(s)).collect();
                json!(refs)
            }),
            "recipientsDisclosed": parsed_opt.as_ref().map(|p| p.recipients_disclosed).unwrap_or(false),
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
        "messageId": message_id_for_json_output(&mid),
        "threadId": message_id_for_json_output(&thread_id),
        "fromAddress": from_address,
        "fromName": from_name,
        "subject": subject,
        "date": date,
        "to": parsed_opt.as_ref().map_or(json!([]), |p| json!(p.to)),
        "cc": parsed_opt.as_ref().map_or(json!([]), |p| json!(p.cc)),
        "bcc": parsed_opt.as_ref().map_or(json!([]), |p| json!(p.bcc)),
        "replyTo": parsed_opt.as_ref().map_or(json!([]), |p| json!(p.reply_to)),
        "inReplyTo": parsed_opt.as_ref().and_then(|p| p.in_reply_to.as_ref().map(|s| message_id_for_json_output(s))),
        "references": parsed_opt.as_ref().map_or(json!([]), |p| {
            let refs: Vec<String> = p.references.iter().map(|s| message_id_for_json_output(s)).collect();
            json!(refs)
        }),
        "recipientsDisclosed": parsed_opt.as_ref().map(|p| p.recipients_disclosed).unwrap_or(false),
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
    use crate::ids::normalize_message_id;
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

    #[test]
    fn search_include_threads_returns_thread_payloads() {
        let conn = empty_db();
        conn.execute(
            "INSERT INTO messages (message_id, thread_id, folder, uid, from_address, to_addresses, cc_addresses, subject, body_text, date, raw_path)
             VALUES ('<m1@test>', '<t1>', 'INBOX', 1, 'a@b.com', '[]', '[]', 'hello', 'needle body', '2024-01-01T00:00:00Z', 'maildir/cur/m1.eml')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (message_id, thread_id, folder, uid, from_address, to_addresses, cc_addresses, subject, body_text, date, raw_path)
             VALUES ('<m2@test>', '<t1>', 'INBOX', 2, 'b@c.com', '[]', '[]', 're: hello', 'needle reply', '2024-01-02T00:00:00Z', 'maildir/cur/m2.eml')",
            [],
        )
        .unwrap();

        let args = serde_json::json!({
            "query": "needle",
            "includeThreads": true
        })
        .as_object()
        .unwrap()
        .clone();
        let s = execute_search_tool(&conn, None, &args).unwrap();
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["threads"].as_array().unwrap().len(), 1);
        assert_eq!(v["threads"][0]["messages"].as_array().unwrap().len(), 2);
    }
}
