//! MCP-style JSON-RPC over stdio (subset of TS MCP server).

use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::ask::tools::execute_get_message_tool;
use crate::attachments::{list_attachments_for_message, read_attachment_text};
use crate::collect_stats;
use crate::config::{load_config, resolve_openai_api_key, LoadConfigOptions};
use crate::draft::DRAFT_NEW_PLACEHOLDER_BODY;
use crate::ids::{resolve_message_id, resolve_thread_id};
use crate::inbox::archive_messages_locally;
use crate::mail_category::parse_category_list;
use crate::mailbox::provider_archive_message;
use crate::search::who::{who, WhoOptions};
use crate::search::{search_with_meta, SearchOptions};
use crate::send::{
    build_draft_list_json_payload, compose_forward_draft_body, compose_new_draft_from_instruction,
    create_draft_id, draft_file_to_json, list_draft_rows, load_forward_source_excerpt, read_draft,
    send_draft_by_id, split_address_list, write_draft, DraftMeta,
};
use crate::status::{format_time_ago, get_status};
use crate::thread_view::list_thread_messages;

#[derive(Debug, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: Option<String>,
    pub id: Option<Value>,
    pub method: String,
    pub params: Option<Value>,
}

#[derive(serde::Serialize)]
struct JsonRpcResponse<'a> {
    jsonrpc: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<&'a Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RpcErrorObj>,
}

#[derive(serde::Serialize)]
struct RpcErrorObj {
    code: i32,
    message: String,
}

/// Stable tool names (must match documented MCP contract count).
pub const TOOL_NAMES: &[&str] = &[
    "search_mail",
    "get_message_by_id",
    "get_thread",
    "who_contacts",
    "get_status",
    "get_stats",
    "list_attachments",
    "read_attachment",
    "create_draft",
    "send_draft",
    "list_drafts",
    "get_draft",
    "delete_draft",
    "archive_mail",
];

pub fn tool_schemas_stable() -> bool {
    TOOL_NAMES.len() == 14
}

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

fn ok(id: Option<&Value>, result: Value) -> String {
    serde_json::to_string(&JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: Some(result),
        error: None,
    })
    .unwrap_or_else(|_| r#"{"jsonrpc":"2.0","error":{"code":-32603,"message":"serialize"}}"#.into())
}

fn err(id: Option<&Value>, code: i32, message: String) -> String {
    serde_json::to_string(&JsonRpcResponse {
        jsonrpc: "2.0",
        id,
        result: None,
        error: Some(RpcErrorObj { code, message }),
    })
    .unwrap_or_else(|_| r#"{"jsonrpc":"2.0","error":{"code":-32603,"message":"serialize"}}"#.into())
}

fn text_content(s: String) -> Value {
    json!({
        "content": [{ "type": "text", "text": s }]
    })
}

fn tools_list_value() -> Value {
    let tools: Vec<Value> = vec![
        json!({
            "name": "search_mail",
            "description": "Search emails using FTS5. Returns a JSON object with results, counts, and optional thread payloads.",
            "inputSchema": schema(json!({
                "query": { "type": "string" },
                "limit": { "type": "integer", "minimum": 1 },
                "offset": { "type": "integer", "minimum": 0 },
                "fromAddress": { "type": "string" },
                "afterDate": { "type": "string" },
                "beforeDate": { "type": "string" },
                "includeThreads": { "type": "boolean" },
                "includeAll": { "type": "boolean" },
                "category": { "type": "string" }
            }), &[])
        }),
        json!({
            "name": "get_message_by_id",
            "description": "Retrieve a single message by message ID.",
            "inputSchema": schema(json!({
                "messageId": { "type": "string" },
                "raw": { "type": "boolean" },
                "detail": { "type": "string", "enum": ["full", "summary", "raw"] },
                "maxBodyChars": { "type": "integer", "minimum": 1 }
            }), &["messageId"])
        }),
        json!({
            "name": "get_thread",
            "description": "Retrieve a full thread by thread ID.",
            "inputSchema": schema(json!({
                "threadId": { "type": "string" }
            }), &["threadId"])
        }),
        json!({
            "name": "who_contacts",
            "description": "Find people by address or display name.",
            "inputSchema": schema(json!({
                "query": { "type": "string" },
                "limit": { "type": "integer", "minimum": 1 },
                "includeNoreply": { "type": "boolean" }
            }), &[])
        }),
        json!({
            "name": "get_status",
            "description": "Get sync and search readiness status.",
            "inputSchema": schema(json!({}), &[])
        }),
        json!({
            "name": "get_stats",
            "description": "Get database statistics.",
            "inputSchema": schema(json!({}), &[])
        }),
        json!({
            "name": "list_attachments",
            "description": "List attachments for a message.",
            "inputSchema": schema(json!({
                "messageId": { "type": "string" }
            }), &["messageId"])
        }),
        json!({
            "name": "read_attachment",
            "description": "Read and extract an attachment to text.",
            "inputSchema": schema(json!({
                "attachmentId": { "type": "integer" }
            }), &["attachmentId"])
        }),
        json!({
            "name": "create_draft",
            "description": "Create a local draft for new mail, replies, or forwards.",
            "inputSchema": schema(json!({
                "kind": { "type": "string", "enum": ["new", "reply", "forward"] },
                "to": {
                    "oneOf": [
                        { "type": "string" },
                        { "type": "array", "items": { "type": "string" } }
                    ]
                },
                "cc": {
                    "oneOf": [
                        { "type": "string" },
                        { "type": "array", "items": { "type": "string" } }
                    ]
                },
                "bcc": {
                    "oneOf": [
                        { "type": "string" },
                        { "type": "array", "items": { "type": "string" } }
                    ]
                },
                "subject": { "type": "string" },
                "body": { "type": "string" },
                "instruction": { "type": "string" },
                "sourceMessageId": { "type": "string" },
                "forwardOf": { "type": "string" },
                "withBody": { "type": "boolean" }
            }), &["kind"])
        }),
        json!({
            "name": "send_draft",
            "description": "Send a local draft via SMTP.",
            "inputSchema": schema(json!({
                "draftId": { "type": "string" },
                "dryRun": { "type": "boolean" }
            }), &["draftId"])
        }),
        json!({
            "name": "list_drafts",
            "description": "List local drafts.",
            "inputSchema": schema(json!({
                "resultFormat": { "type": "string", "enum": ["auto", "full", "slim"] }
            }), &[])
        }),
        json!({
            "name": "get_draft",
            "description": "Read one draft by ID.",
            "inputSchema": schema(json!({
                "draftId": { "type": "string" },
                "withBody": { "type": "boolean" }
            }), &["draftId"])
        }),
        json!({
            "name": "delete_draft",
            "description": "Delete one draft by ID.",
            "inputSchema": schema(json!({
                "draftId": { "type": "string" }
            }), &["draftId"])
        }),
        json!({
            "name": "archive_mail",
            "description": "Set or clear local is_archived for one or more messages; optional IMAP when mailboxManagement is enabled.",
            "inputSchema": schema(json!({
                "messageIds": {
                    "oneOf": [
                        { "type": "string" },
                        { "type": "array", "items": { "type": "string" } }
                    ]
                },
                "undo": { "type": "boolean" }
            }), &["messageIds"])
        }),
    ];
    json!({ "tools": tools })
}

fn parse_string_list_arg(args: &Value, key: &str) -> Option<Vec<String>> {
    match args.get(key) {
        Some(Value::String(s)) => {
            let values = split_address_list(s);
            if values.is_empty() {
                None
            } else {
                Some(values)
            }
        }
        Some(Value::Array(items)) => {
            let values: Vec<String> = items
                .iter()
                .filter_map(|item| item.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if values.is_empty() {
                None
            } else {
                Some(values)
            }
        }
        _ => None,
    }
}

/// Handle one JSON-RPC line against an open DB connection (`data_dir` for drafts path).
pub fn handle_request_line(
    conn: &Connection,
    data_dir: &std::path::Path,
    cache_extracted: bool,
    line: &str,
) -> String {
    let Ok(req) = serde_json::from_str::<JsonRpcRequest>(line.trim()) else {
        return err(None, -32700, "Parse error".into());
    };
    let id = req.id.as_ref();

    match req.method.as_str() {
        "initialize" => ok(
            id,
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "serverInfo": { "name": "zmail", "version": "0.1.0" },
            }),
        ),
        "tools/list" => ok(id, tools_list_value()),
        "tools/call" => {
            let Some(p) = req.params else {
                return err(id, -32602, "Missing params".into());
            };
            let name = p.get("name").and_then(|x| x.as_str()).unwrap_or("");
            let args = p.get("arguments").cloned().unwrap_or(json!({}));
            tool_call(conn, data_dir, cache_extracted, id, name, args)
        }
        _ => err(id, -32601, format!("Method not found: {}", req.method)),
    }
}

fn tool_call(
    conn: &Connection,
    data_dir: &std::path::Path,
    cache_extracted: bool,
    id: Option<&Value>,
    name: &str,
    args: Value,
) -> String {
    let out: Result<String, String> = match name {
        "search_mail" => {
            let q = args.get("query").and_then(|x| x.as_str()).unwrap_or("");
            let limit = args
                .get("limit")
                .and_then(|x| x.as_u64())
                .map(|n| n as usize)
                .unwrap_or(10);
            let offset = args
                .get("offset")
                .and_then(|x| x.as_u64())
                .map(|n| n as usize)
                .unwrap_or(0);
            search_with_meta(
                conn,
                &SearchOptions {
                    query: Some(q.into()),
                    limit: Some(limit),
                    offset,
                    from_address: args
                        .get("fromAddress")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string()),
                    after_date: args
                        .get("afterDate")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string()),
                    before_date: args
                        .get("beforeDate")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string()),
                    include_all: args
                        .get("includeAll")
                        .and_then(|x| x.as_bool())
                        .unwrap_or(false),
                    categories: args
                        .get("category")
                        .and_then(|x| x.as_str())
                        .map(parse_category_list)
                        .unwrap_or_default(),
                    ..Default::default()
                },
            )
            .and_then(|s| {
                let mut payload = serde_json::Map::new();
                payload.insert(
                    "results".into(),
                    serde_json::to_value(&s.results).unwrap_or(json!([])),
                );
                payload.insert("returned".into(), json!(s.results.len()));
                payload.insert("totalMatched".into(), json!(s.total_matched));
                if args
                    .get("includeThreads")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false)
                {
                    let mut seen = std::collections::HashSet::new();
                    let mut threads = Vec::new();
                    for row in &s.results {
                        if seen.insert(row.thread_id.clone()) {
                            let rows = list_thread_messages(conn, &row.thread_id)?;
                            threads.push(json!({
                                "threadId": row.thread_id,
                                "messages": rows,
                            }));
                        }
                    }
                    payload.insert("threads".into(), json!(threads));
                }
                Ok(Value::Object(payload).to_string())
            })
            .map_err(|e| e.to_string())
        }
        "get_message_by_id" => {
            let map = args.as_object().cloned().unwrap_or_default();
            execute_get_message_tool(conn, data_dir, &map).map_err(|e| e.to_string())
        }
        "get_thread" => {
            let tid_arg = args.get("threadId").and_then(|x| x.as_str()).unwrap_or("");
            match resolve_thread_id(conn, tid_arg) {
                Ok(Some(t)) => list_thread_messages(conn, &t)
                    .map(|rows| serde_json::to_string(&rows).unwrap_or_default())
                    .map_err(|e| e.to_string()),
                Ok(None) => Ok("[]".into()),
                Err(e) => Err(e.to_string()),
            }
        }
        "who_contacts" => {
            let q = args.get("query").and_then(|x| x.as_str()).unwrap_or("");
            who(
                conn,
                &WhoOptions {
                    query: q.into(),
                    limit: args
                        .get("limit")
                        .and_then(|x| x.as_u64())
                        .map(|n| n as usize)
                        .unwrap_or(20),
                    include_noreply: args
                        .get("includeNoreply")
                        .and_then(|x| x.as_bool())
                        .unwrap_or(false),
                },
            )
            .map(|w| serde_json::to_string(&w).unwrap_or_default())
            .map_err(|e: rusqlite::Error| e.to_string())
        }
        "get_status" => get_status(conn)
            .map(|s| {
                let latest_mail_ago = format_time_ago(s.date_range.as_ref().map(|(_, l)| l.as_str()));
                let last_sync_ago = if s.sync.is_running {
                    None
                } else {
                    format_time_ago(s.sync.last_sync_at.as_deref())
                };
                serde_json::to_string(&json!({
                    "sync": {
                        "isRunning": s.sync.is_running,
                        "lastSyncAt": s.sync.last_sync_at,
                        "totalMessages": s.sync.total_messages,
                        "earliestSyncedDate": s.sync.earliest_synced_date,
                        "latestSyncedDate": s.sync.latest_synced_date,
                        "targetStartDate": s.sync.target_start_date,
                        "syncStartEarliestDate": s.sync.sync_start_earliest_date,
                    },
                    "search": { "ftsReady": s.fts_ready },
                    "dateRange": s.date_range.as_ref().map(|(a, b)| json!({ "earliest": a, "latest": b })),
                    "freshness": {
                        "latestMailAgo": latest_mail_ago.as_ref().map(|t| json!({ "human": t.human, "duration": t.duration })),
                        "lastSyncAgo": last_sync_ago.as_ref().map(|t| json!({ "human": t.human, "duration": t.duration })),
                    }
                }))
                .unwrap_or_default()
            })
            .map_err(|e| e.to_string()),
        "get_stats" => collect_stats(conn)
            .map(|s| serde_json::to_string(&s).unwrap_or_default())
            .map_err(|e| e.to_string()),
        "list_attachments" => {
            let mid_arg = args.get("messageId").and_then(|x| x.as_str()).unwrap_or("");
            list_attachments_for_message(conn, mid_arg)
                .map(|rows| serde_json::to_string(&rows).unwrap_or_default())
                .map_err(|e| e.to_string())
        }
        "read_attachment" => {
            let aid = args
                .get("attachmentId")
                .and_then(|x| x.as_i64())
                .or_else(|| {
                    args.get("attachmentId")
                        .and_then(|x| x.as_u64())
                        .map(|u| u as i64)
                });
            match aid {
                Some(aid) => read_attachment_text(conn, data_dir, aid, cache_extracted, false),
                None => Err("attachmentId (number) required".into()),
            }
        }
        "create_draft" => (|| -> Result<String, String> {
            let kind = args.get("kind").and_then(|x| x.as_str()).unwrap_or("new");
            let with_body = args
                .get("withBody")
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            let drafts_dir = data_dir.join("drafts");
            match kind {
                "new" => {
                    let to_list = parse_string_list_arg(&args, "to")
                        .ok_or_else(|| "new draft requires to".to_string())?;
                    let subject = args
                        .get("subject")
                        .and_then(|x| x.as_str())
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string());
                    let instruction = args
                        .get("instruction")
                        .and_then(|x| x.as_str())
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string());
                    let explicit_body = args.get("body").and_then(|x| x.as_str()).unwrap_or("");
                    let (final_subject, final_body) = if let Some(subject) = subject {
                        (subject, explicit_body.to_string())
                    } else if let Some(instruction) = instruction {
                        let api_key = resolve_openai_api_key(&LoadConfigOptions {
                            home: std::env::var("ZMAIL_HOME")
                                .ok()
                                .map(std::path::PathBuf::from),
                            env: None,
                        })
                        .ok_or_else(|| {
                            "LLM compose requires ZMAIL_OPENAI_API_KEY or OPENAI_API_KEY"
                                .to_string()
                        })?;
                        let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
                        rt.block_on(compose_new_draft_from_instruction(
                            to_list.clone(),
                            &instruction,
                            &api_key,
                        ))
                        .map_err(|e| e.to_string())?
                    } else {
                        ("(no subject yet)".into(), DRAFT_NEW_PLACEHOLDER_BODY.into())
                    };
                    let meta = DraftMeta {
                        kind: Some("new".into()),
                        to: Some(to_list),
                        cc: parse_string_list_arg(&args, "cc"),
                        bcc: parse_string_list_arg(&args, "bcc"),
                        subject: Some(final_subject.clone()),
                        ..Default::default()
                    };
                    let draft_id =
                        create_draft_id(&drafts_dir, &final_subject).map_err(|e| e.to_string())?;
                    write_draft(&drafts_dir, &draft_id, &meta, &final_body)
                        .map_err(|e| e.to_string())?;
                    let draft = read_draft(&drafts_dir.join(format!("{draft_id}.md")))
                        .map_err(|e| e.to_string())?;
                    Ok(serde_json::to_string(&draft_file_to_json(&draft, with_body)).unwrap_or_default())
                }
                "reply" => {
                    let source_message_id = args
                        .get("sourceMessageId")
                        .and_then(|x| x.as_str())
                        .ok_or_else(|| "reply requires sourceMessageId".to_string())?;
                    let Some(mid) =
                        resolve_message_id(conn, source_message_id).map_err(|e| e.to_string())?
                    else {
                        return Err("message not found".into());
                    };
                    let row: Option<(String, String, String, String)> = conn
                        .query_row(
                            "SELECT message_id, from_address, subject, thread_id FROM messages WHERE message_id = ?1",
                            [&mid],
                            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                        )
                        .optional()
                        .map_err(|e| e.to_string())?;
                    let Some((message_id, from_address, source_subject, thread_id)) = row else {
                        return Err("message not found".into());
                    };
                    let to_list =
                        parse_string_list_arg(&args, "to").unwrap_or_else(|| vec![from_address]);
                    let subject = args
                        .get("subject")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| {
                            if source_subject.starts_with("Re:") {
                                source_subject.clone()
                            } else {
                                format!("Re: {source_subject}")
                            }
                        });
                    let body = args.get("body").and_then(|x| x.as_str()).unwrap_or("");
                    let meta = DraftMeta {
                        kind: Some("reply".into()),
                        to: Some(to_list),
                        cc: parse_string_list_arg(&args, "cc"),
                        bcc: parse_string_list_arg(&args, "bcc"),
                        subject: Some(subject.clone()),
                        source_message_id: Some(message_id),
                        thread_id: Some(thread_id),
                        ..Default::default()
                    };
                    let draft_id =
                        create_draft_id(&drafts_dir, &subject).map_err(|e| e.to_string())?;
                    write_draft(&drafts_dir, &draft_id, &meta, body).map_err(|e| e.to_string())?;
                    let draft = read_draft(&drafts_dir.join(format!("{draft_id}.md")))
                        .map_err(|e| e.to_string())?;
                    Ok(serde_json::to_string(&draft_file_to_json(&draft, with_body)).unwrap_or_default())
                }
                "forward" => {
                    let forward_of = args
                        .get("forwardOf")
                        .and_then(|x| x.as_str())
                        .ok_or_else(|| "forward requires forwardOf".to_string())?;
                    let to_list = parse_string_list_arg(&args, "to")
                        .ok_or_else(|| "forward requires to".to_string())?;
                    let Some(mid) =
                        resolve_message_id(conn, forward_of).map_err(|e| e.to_string())?
                    else {
                        return Err("message not found".into());
                    };
                    let row: Option<(String, String, String)> = conn
                        .query_row(
                            "SELECT message_id, subject, thread_id FROM messages WHERE message_id = ?1",
                            [&mid],
                            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                        )
                        .optional()
                        .map_err(|e| e.to_string())?;
                    let Some((message_id, source_subject, thread_id)) = row else {
                        return Err("message not found".into());
                    };
                    let subject = args
                        .get("subject")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| format!("Fwd: {source_subject}"));
                    let preamble = args.get("body").and_then(|x| x.as_str()).unwrap_or("");
                    let excerpt = load_forward_source_excerpt(conn, data_dir, &message_id)
                        .map_err(|e| e.to_string())?;
                    let body = compose_forward_draft_body(preamble, &excerpt);
                    let meta = DraftMeta {
                        kind: Some("forward".into()),
                        to: Some(to_list),
                        cc: parse_string_list_arg(&args, "cc"),
                        bcc: parse_string_list_arg(&args, "bcc"),
                        subject: Some(subject.clone()),
                        forward_of: Some(message_id.to_string()),
                        thread_id: Some(thread_id),
                        ..Default::default()
                    };
                    let draft_id =
                        create_draft_id(&drafts_dir, &subject).map_err(|e| e.to_string())?;
                    write_draft(&drafts_dir, &draft_id, &meta, &body)
                        .map_err(|e| e.to_string())?;
                    let draft = read_draft(&drafts_dir.join(format!("{draft_id}.md")))
                        .map_err(|e| e.to_string())?;
                    Ok(serde_json::to_string(&draft_file_to_json(&draft, with_body)).unwrap_or_default())
                }
                _ => Err("kind must be one of: new, reply, forward".into()),
            }
        })(),
        "send_draft" => {
            let dry = args
                .get("dryRun")
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            let draft_id = args.get("draftId").and_then(|x| x.as_str()).unwrap_or("");
            if draft_id.trim().is_empty() {
                Err("draftId required".into())
            } else {
                let cfg = load_config(LoadConfigOptions {
                    home: std::env::var("ZMAIL_HOME")
                        .ok()
                        .map(std::path::PathBuf::from),
                    env: None,
                });
                send_draft_by_id(&cfg, data_dir, draft_id, dry).and_then(|result| {
                    serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
                })
            }
        }
        "list_drafts" => {
            let dir = data_dir.join("drafts");
            let preference = match args.get("resultFormat").and_then(|x| x.as_str()) {
                Some("full") => crate::search::SearchResultFormatPreference::Full,
                Some("slim") => crate::search::SearchResultFormatPreference::Slim,
                _ => crate::search::SearchResultFormatPreference::Auto,
            };
            list_draft_rows(&dir)
                .map(|rows| {
                    serde_json::to_string(&build_draft_list_json_payload(&rows, preference))
                        .unwrap_or_default()
                })
                .map_err(|e| e.to_string())
        }
        "get_draft" => {
            let did = args.get("draftId").and_then(|x| x.as_str()).unwrap_or("x");
            let normalized = did.strip_suffix(".md").unwrap_or(did);
            let p = data_dir.join("drafts").join(format!("{normalized}.md"));
            let with_body = args
                .get("withBody")
                .and_then(|x| x.as_bool())
                .unwrap_or(true);
            read_draft(&p)
                .map(|d| serde_json::to_string(&draft_file_to_json(&d, with_body)).unwrap_or_default())
                .map_err(|e| e.to_string())
        }
        "delete_draft" => (|| -> Result<String, String> {
            let draft_id = args.get("draftId").and_then(|x| x.as_str()).unwrap_or("");
            if draft_id.trim().is_empty() {
                Err("draftId required".into())
            } else {
                let normalized = draft_id.strip_suffix(".md").unwrap_or(draft_id);
                let path = data_dir.join("drafts").join(format!("{normalized}.md"));
                std::fs::remove_file(&path).map_err(|e| e.to_string())?;
                Ok(json!({ "ok": true, "draftId": normalized }).to_string())
            }
        })(),
        "archive_mail" => (|| -> Result<String, String> {
            let ids = parse_string_list_arg(&args, "messageIds").ok_or_else(|| {
                "messageIds required (string or array of strings)".to_string()
            })?;
            let undo = args.get("undo").and_then(|x| x.as_bool()).unwrap_or(false);
            let archived = !undo;
            let cfg = load_config(LoadConfigOptions {
                home: std::env::var("ZMAIL_HOME").ok().map(std::path::PathBuf::from),
                env: None,
            });
            let mut results = Vec::new();
            for mid in ids {
                let local_ok = archive_messages_locally(conn, std::slice::from_ref(&mid), archived)
                    .map_err(|e| e.to_string())?;
                let provider = provider_archive_message(&cfg, conn, &mid, undo);
                results.push(json!({
                    "messageId": mid,
                    "local": { "ok": local_ok > 0, "isArchived": archived },
                    "providerMutation": provider,
                }));
            }
            serde_json::to_string(&json!({ "results": results })).map_err(|e| e.to_string())
        })(),
        _ => Err(format!("Unknown tool {name}")),
    };

    match out {
        Ok(text) => ok(id, text_content(text)),
        Err(m) => err(id, -32000, m),
    }
}
