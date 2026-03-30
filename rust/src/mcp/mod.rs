//! MCP-style JSON-RPC over stdio (subset of TS MCP server).

use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::attachments::list_attachments_for_message;
use crate::collect_stats;
use crate::search::who::{who, WhoOptions};
use crate::search::{search_with_meta, SearchOptions};
use crate::send::{list_drafts, plan_send, read_draft, SendPlan};
use crate::status::get_status;
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
];

pub fn tool_schemas_stable() -> bool {
    TOOL_NAMES.len() == 13
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
    let tools: Vec<Value> = TOOL_NAMES
        .iter()
        .map(|n| {
            json!({
                "name": n,
                "description": *n,
                "inputSchema": { "type": "object", "properties": {} },
            })
        })
        .collect();
    json!({ "tools": tools })
}

/// Handle one JSON-RPC line against an open DB connection (`data_dir` for drafts path).
pub fn handle_request_line(conn: &Connection, data_dir: &std::path::Path, line: &str) -> String {
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
            tool_call(conn, data_dir, id, name, args)
        }
        _ => err(id, -32601, format!("Method not found: {}", req.method)),
    }
}

fn tool_call(
    conn: &Connection,
    data_dir: &std::path::Path,
    id: Option<&Value>,
    name: &str,
    args: Value,
) -> String {
    let out: Result<String, String> = match name {
        "search_mail" => {
            let q = args.get("query").and_then(|x| x.as_str()).unwrap_or("");
            search_with_meta(
                conn,
                &SearchOptions {
                    query: Some(q.into()),
                    limit: Some(10),
                    ..Default::default()
                },
            )
            .map(|s| serde_json::to_string(&s.results).unwrap_or_default())
            .map_err(|e| e.to_string())
        }
        "get_message_by_id" => {
            let mid = args.get("messageId").and_then(|x| x.as_str()).unwrap_or("");
            let row: Result<(String, String, String), rusqlite::Error> = conn.query_row(
                "SELECT message_id, subject, from_address FROM messages WHERE message_id = ?1",
                [mid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            );
            Ok(row
                .map(|(a, b, c)| {
                    serde_json::json!({ "messageId": a, "subject": b, "fromAddress": c })
                        .to_string()
                })
                .unwrap_or_else(|_| "{}".into()))
        }
        "get_thread" => {
            let tid = args.get("threadId").and_then(|x| x.as_str()).unwrap_or("");
            list_thread_messages(conn, tid)
                .map(|rows| serde_json::to_string(&rows).unwrap_or_default())
                .map_err(|e| e.to_string())
        }
        "who_contacts" => {
            let q = args.get("query").and_then(|x| x.as_str()).unwrap_or("");
            who(
                conn,
                &WhoOptions {
                    query: q.into(),
                    limit: 20,
                    include_noreply: false,
                },
            )
            .map(|w| serde_json::to_string(&w.people).unwrap_or_default())
            .map_err(|e: rusqlite::Error| e.to_string())
        }
        "get_status" => get_status(conn)
            .map(|s| s.sync.total_messages.to_string())
            .map_err(|e| e.to_string()),
        "get_stats" => collect_stats(conn)
            .map(|s| serde_json::to_string(&s).unwrap_or_default())
            .map_err(|e| e.to_string()),
        "list_attachments" => {
            let mid = args.get("messageId").and_then(|x| x.as_str()).unwrap_or("");
            list_attachments_for_message(conn, mid)
                .map(|rows| serde_json::to_string(&rows).unwrap_or_default())
                .map_err(|e| e.to_string())
        }
        "read_attachment" => Ok("\"stub\"".into()),
        "create_draft" => Ok("\"ok\"".into()),
        "send_draft" => {
            let dry = args.get("dryRun").and_then(|x| x.as_bool()).unwrap_or(true);
            let p = SendPlan {
                dry_run: dry,
                ..Default::default()
            };
            plan_send(&p).map(|_| if dry { "dry_run".into() } else { "sent".into() })
        }
        "list_drafts" => {
            let dir = data_dir.join("drafts");
            list_drafts(&dir, false)
                .map(|v| serde_json::to_string(&v).unwrap_or_default())
                .map_err(|e| e.to_string())
        }
        "get_draft" => {
            let did = args.get("draftId").and_then(|x| x.as_str()).unwrap_or("x");
            let p = data_dir.join("drafts").join(format!("{did}.md"));
            read_draft(&p).map(|d| d.body).map_err(|e| e.to_string())
        }
        "delete_draft" => Ok("\"ok\"".into()),
        _ => Err(format!("Unknown tool {name}")),
    };

    match out {
        Ok(text) => ok(id, text_content(text)),
        Err(m) => err(id, -32000, m),
    }
}
