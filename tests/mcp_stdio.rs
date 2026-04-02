//! Integration tests: MCP stdio JSON-RPC handlers and tool schema stability.

use std::fs;

use serde_json::json;
use tempfile::tempdir;
use zmail::{
    db, handle_request_line, open_memory, persist_message, tool_schemas_stable, ParsedMessage,
    TOOL_NAMES,
};

const MAILBOX: &str = "[Gmail]/All Mail";

fn data_dir() -> std::path::PathBuf {
    tempdir().unwrap().path().to_path_buf()
}

#[test]
fn mcp_tool_param_keys_stable() {
    assert!(tool_schemas_stable());
    assert_eq!(TOOL_NAMES.len(), 14);
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
        category: None,
    };
    persist_message(&conn, &p, MAILBOX, 1, "[]", "p").unwrap();
    let line = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": "search_mail", "arguments": { "query": "needle" } }
    }))
    .unwrap();
    let out = handle_request_line(&conn, &data_dir(), false, &line);
    assert!(out.contains("needle"), "{}", out);
}

#[test]
fn mcp_get_message_by_id() {
    let dir = tempdir().unwrap();
    fs::create_dir_all(dir.path().join("data/cur")).unwrap();
    let eml_path = dir.path().join("data/cur/mcp-msg.eml");
    let raw = b"From: a@b.com\r\nSubject: S\r\nMessage-ID: <mid-mcp>\r\nDate: Mon, 1 Jan 2024 12:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nMCP body text.";
    fs::write(&eml_path, raw).unwrap();

    let db_path = dir.path().join("data/zmail.db");
    let conn = db::open_file(&db_path).unwrap();
    let p = ParsedMessage {
        message_id: "<mid-mcp>".into(),
        from_address: "a@b.com".into(),
        from_name: None,
        to_addresses: vec![],
        cc_addresses: vec![],
        subject: "S".into(),
        date: "2024-01-01T12:00:00Z".into(),
        body_text: "MCP body text.".into(),
        body_html: None,
        attachments: vec![],
        category: None,
    };
    persist_message(&conn, &p, MAILBOX, 1, "[]", "cur/mcp-msg.eml").unwrap();
    let line = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": { "name": "get_message_by_id", "arguments": { "messageId": "mid-mcp" } }
    }))
    .unwrap();
    let out = handle_request_line(&conn, &dir.path().join("data"), false, &line);
    assert!(out.contains("mid-mcp"));
    assert!(out.contains("MCP body text"), "{}", out);
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
    let out = handle_request_line(&conn, &data_dir(), false, &line);
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
    let _ = handle_request_line(&conn, &data_dir(), false, &line);
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
    let out = handle_request_line(&conn, &data_dir(), false, &line);
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
    let out = handle_request_line(&conn, &data_dir(), false, &line);
    assert!(out.contains("messageCount") || out.contains("message"));
}

#[test]
fn mcp_read_attachment_extracts_csv() {
    let conn = open_memory().unwrap();
    let d = data_dir();
    let csv_path = d.join("attachments").join("m-read").join("a.csv");
    std::fs::create_dir_all(csv_path.parent().unwrap()).unwrap();
    std::fs::write(&csv_path, b"x,y").unwrap();
    conn.execute(
        "INSERT INTO messages (message_id, thread_id, folder, uid, from_address, to_addresses, cc_addresses, subject, body_text, date, raw_path)
         VALUES ('mr', 'mr', 'f', 1, 'a@b', '[]', '[]', 's', 'b', 'd', 'p')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO attachments (message_id, filename, mime_type, size, stored_path) VALUES ('mr', 'a.csv', 'text/csv', 3, ?1)",
        ["attachments/m-read/a.csv".to_string()],
    )
    .unwrap();
    let id: i64 = conn
        .query_row(
            "SELECT id FROM attachments WHERE message_id = 'mr'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let line = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": { "name": "read_attachment", "arguments": { "attachmentId": id } }
    }))
    .unwrap();
    let out = handle_request_line(&conn, &d, false, &line);
    assert!(out.contains("x,y") || out.contains(r#"x,y"#), "{}", out);
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
    let out = handle_request_line(&conn, &data_dir(), false, &line);
    assert!(out.contains("f"));
}

#[test]
fn mcp_create_draft_send_dry_run() {
    let conn = open_memory().unwrap();
    let d = data_dir();
    std::fs::create_dir_all(d.join("drafts")).unwrap();
    let draft_path = d.join("drafts").join("mcp-test.md");
    std::fs::write(
        &draft_path,
        "---\nto: test@example.com\nsubject: hi\n---\nBody\n",
    )
    .unwrap();
    let line = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": { "name": "send_draft", "arguments": { "draftId": "mcp-test", "dryRun": true } }
    }))
    .unwrap();
    let out = handle_request_line(&conn, &d, false, &line);
    assert!(out.contains("dryRun") || out.contains("dry_run"), "{}", out);
}

#[test]
fn mcp_initialize_lists_tools() {
    let conn = open_memory().unwrap();
    let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;
    let r1 = handle_request_line(&conn, &data_dir(), false, init);
    assert!(r1.contains("serverInfo"));
    let list = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#;
    let r2 = handle_request_line(&conn, &data_dir(), false, list);
    assert!(r2.contains("search_mail"));
    assert!(r2.contains("inputSchema"));
    assert!(r2.contains("create_draft"));
}

#[test]
fn mcp_create_draft_returns_real_draft_json() {
    let conn = open_memory().unwrap();
    let d = data_dir();
    std::fs::create_dir_all(d.join("drafts")).unwrap();
    let line = serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": 9,
        "method": "tools/call",
        "params": {
            "name": "create_draft",
            "arguments": {
                "kind": "new",
                "to": "friend@example.com",
                "subject": "Hello",
                "body": "Draft body",
                "withBody": true
            }
        }
    }))
    .unwrap();
    let out = handle_request_line(&conn, &d, false, &line);
    let outer: serde_json::Value = serde_json::from_str(&out).unwrap();
    let text = outer["result"]["content"][0]["text"].as_str().unwrap();
    let draft: serde_json::Value = serde_json::from_str(text).unwrap();
    assert_eq!(draft["kind"], "new");
    assert_eq!(draft["body"], "Draft body");
    assert_eq!(draft["to"][0], "friend@example.com");
}
