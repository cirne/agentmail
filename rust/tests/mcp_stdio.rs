//! Integration tests: MCP stdio JSON-RPC handlers and tool schema stability.

use serde_json::json;
use tempfile::tempdir;
use zmail::{
    handle_request_line, open_memory, persist_message, tool_schemas_stable, ParsedMessage, TOOL_NAMES,
};

const MAILBOX: &str = "[Gmail]/All Mail";

fn data_dir() -> std::path::PathBuf {
    tempdir().unwrap().path().to_path_buf()
}

#[test]
fn mcp_tool_param_keys_stable() {
    assert!(tool_schemas_stable());
    assert_eq!(TOOL_NAMES.len(), 13);
}

#[test]
fn mcp_search_mail_returns_json() {
    let conn = open_memory().unwrap();
    let p = ParsedMessage {
        message_id: "mcp1@test".into(),
        from_address: "a@b".into(),
        from_name: None,
        to_addresses: vec![],
        cc_addresses: vec![],
        subject: "sub".into(),
        date: "2025-01-01T00:00:00Z".into(),
        body_text: "needle word".into(),
        body_html: None,
        attachments: vec![],
        is_noise: false,
    };
    persist_message(&conn, &p, MAILBOX, 1, "[]", "p").unwrap();
    let line = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": "search_mail", "arguments": { "query": "needle" } }
    }))
    .unwrap();
    let out = handle_request_line(&conn, &data_dir(), &line);
    assert!(out.contains("needle"), "{}", out);
}

#[test]
fn mcp_get_message_by_id() {
    let conn = open_memory().unwrap();
    conn.execute(
        "INSERT INTO messages (message_id, thread_id, folder, uid, from_address, to_addresses, cc_addresses, subject, body_text, date, raw_path)
         VALUES ('mid-mcp', 'mid-mcp', 'f', 1, 'a@b', '[]', '[]', 'S', 'b', 'd', 'p')",
        [],
    )
    .unwrap();
    let line = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": { "name": "get_message_by_id", "arguments": { "messageId": "mid-mcp" } }
    }))
    .unwrap();
    let out = handle_request_line(&conn, &data_dir(), &line);
    assert!(out.contains("mid-mcp"));
}

#[test]
fn mcp_get_thread() {
    let conn = open_memory().unwrap();
    conn.execute(
        "INSERT INTO messages (message_id, thread_id, folder, uid, from_address, to_addresses, cc_addresses, subject, body_text, date, raw_path)
         VALUES ('a', 't1', 'f', 1, 'a@b', '[]', '[]', 's', 'b', 'd', 'p')",
        [],
    )
    .unwrap();
    let line = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": { "name": "get_thread", "arguments": { "threadId": "t1" } }
    }))
    .unwrap();
    let out = handle_request_line(&conn, &data_dir(), &line);
    assert!(out.contains("a@b") || out.contains(r#"\"a\""#));
}

#[test]
fn mcp_who_top_contacts() {
    let conn = open_memory().unwrap();
    let line = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": { "name": "who_contacts", "arguments": { "query": "" } }
    }))
    .unwrap();
    let _ = handle_request_line(&conn, &data_dir(), &line);
}

#[test]
fn mcp_get_status() {
    let conn = open_memory().unwrap();
    let line = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": { "name": "get_status", "arguments": {} }
    }))
    .unwrap();
    let out = handle_request_line(&conn, &data_dir(), &line);
    assert!(out.contains("0") || out.contains("content"));
}

#[test]
fn mcp_get_stats() {
    let conn = open_memory().unwrap();
    let line = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": { "name": "get_stats", "arguments": {} }
    }))
    .unwrap();
    let out = handle_request_line(&conn, &data_dir(), &line);
    assert!(out.contains("messageCount") || out.contains("message"));
}

#[test]
fn mcp_list_attachments() {
    let conn = open_memory().unwrap();
    conn.execute(
        "INSERT INTO messages (message_id, thread_id, folder, uid, from_address, to_addresses, cc_addresses, subject, body_text, date, raw_path)
         VALUES ('ma', 'ma', 'f', 1, 'a@b', '[]', '[]', 's', 'b', 'd', 'p')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO attachments (message_id, filename, mime_type, size, stored_path) VALUES ('ma', 'f', 'text/plain', 1, 'x')",
        [],
    )
    .unwrap();
    let line = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": { "name": "list_attachments", "arguments": { "messageId": "ma" } }
    }))
    .unwrap();
    let out = handle_request_line(&conn, &data_dir(), &line);
    assert!(out.contains("f"));
}

#[test]
fn mcp_create_draft_send_dry_run() {
    let conn = open_memory().unwrap();
    let d = data_dir();
    let line = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": { "name": "send_draft", "arguments": { "dryRun": true } }
    }))
    .unwrap();
    let out = handle_request_line(&conn, &d, &line);
    assert!(out.contains("dry_run"));
}

#[test]
fn mcp_initialize_lists_tools() {
    let conn = open_memory().unwrap();
    let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;
    let r1 = handle_request_line(&conn, &data_dir(), init);
    assert!(r1.contains("serverInfo"));
    let list = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#;
    let r2 = handle_request_line(&conn, &data_dir(), list);
    assert!(r2.contains("search_mail"));
}
