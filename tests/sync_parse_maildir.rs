//! Integration tests: MIME parse, sync windows/UIDs, maildir write, process lock, persist + FTS triggers.

use std::fs;
use tempfile::tempdir;
use zmail::{
    acquire_lock, filter_uids_after, forward_uid_range, fts_match_count, is_process_alive,
    is_sync_lock_held, oldest_message_date_for_folder, open_memory, parse_index_message,
    parse_raw_message, parse_raw_message_with_options, parse_since_to_date, persist_message,
    release_lock, same_calendar_day, write_maildir_message, LockResult, ParseMessageOptions,
    ParsedMessage, SyncLockRow,
};

const MAILBOX: &str = "[Gmail]/All Mail";

#[test]
fn parse_message_plain_text() {
    let raw = b"From: alice@example.com\r\n\
To: bob@example.com\r\n\
Subject: Hello\r\n\
Date: Mon, 1 Jan 2024 12:00:00 +0000\r\n\
Message-ID: <plain-1@test>\r\n\
MIME-Version: 1.0\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
Hello world body.";
    let p = parse_raw_message(raw);
    assert_eq!(p.from_address, "alice@example.com");
    assert_eq!(p.subject, "Hello");
    assert!(p.body_text.contains("Hello world"));
}

#[test]
fn parse_message_html_only() {
    let raw = b"From: web@example.com\r\n\
Subject: HTML only\r\n\
Date: Tue, 2 Jan 2024 10:00:00 +0000\r\n\
Message-ID: <html-1@test>\r\n\
MIME-Version: 1.0\r\n\
Content-Type: text/html; charset=utf-8\r\n\
\r\n\
<p>Hi <b>there</b></p>";
    let p = parse_raw_message(raw);
    assert!(!p.body_text.is_empty(), "body_text: {:?}", p.body_text);
    assert!(p.body_html.is_some());
}

#[test]
fn parse_message_category_list_id() {
    let raw = b"From: list@example.com\r\n\
Subject: Newsletter\r\n\
Date: Wed, 3 Jan 2024 10:00:00 +0000\r\n\
Message-ID: <list-1@test>\r\n\
List-Id: <news.example.com>\r\n\
MIME-Version: 1.0\r\n\
Content-Type: text/plain\r\n\
\r\n\
Body";
    let p = parse_raw_message(raw);
    assert_eq!(p.category.as_deref(), Some("list"));
}

#[test]
fn parse_message_attachments() {
    let raw = concat!(
        "From: a@b.com\r\n",
        "Subject: att\r\n",
        "Date: Thu, 4 Jan 2024 10:00:00 +0000\r\n",
        "Message-ID: <att@test>\r\n",
        "MIME-Version: 1.0\r\n",
        "Content-Type: multipart/mixed; boundary=\"b\"\r\n",
        "\r\n",
        "--b\r\n",
        "Content-Type: text/plain\r\n",
        "\r\n",
        "Hi\r\n",
        "--b\r\n",
        "Content-Type: application/octet-stream; name=\"f.txt\"\r\n",
        "Content-Disposition: attachment; filename=\"f.txt\"\r\n",
        "\r\n",
        "data\r\n",
        "--b--\r\n",
    );
    let p = parse_raw_message(raw.as_bytes());
    assert!(
        p.attachments.iter().any(|a| a.filename == "f.txt"),
        "attachments: {:?}",
        p.attachments
    );
}

#[test]
fn parse_index_message_skips_attachment_bytes() {
    let raw = concat!(
        "From: a@b.com\r\n",
        "Subject: att\r\n",
        "Date: Thu, 4 Jan 2024 10:00:00 +0000\r\n",
        "Message-ID: <att-skip@test>\r\n",
        "MIME-Version: 1.0\r\n",
        "Content-Type: multipart/mixed; boundary=\"b\"\r\n",
        "\r\n",
        "--b\r\n",
        "Content-Type: text/plain\r\n",
        "\r\n",
        "Hi there\r\n",
        "--b\r\n",
        "Content-Type: application/octet-stream; name=\"f.txt\"\r\n",
        "Content-Disposition: attachment; filename=\"f.txt\"\r\n",
        "\r\n",
        "data\r\n",
        "--b--\r\n",
    );
    let full = parse_raw_message(raw.as_bytes());
    let indexed = parse_index_message(raw.as_bytes());
    let explicit = parse_raw_message_with_options(
        raw.as_bytes(),
        ParseMessageOptions {
            include_attachments: false,
        },
    );

    assert_eq!(full.subject, indexed.subject);
    assert_eq!(full.body_text, indexed.body_text);
    assert!(full.attachments.iter().any(|a| a.filename == "f.txt"));
    assert!(indexed.attachments.is_empty());
    assert!(explicit.attachments.is_empty());
    assert_eq!(indexed.subject, explicit.subject);
}

#[test]
fn sync_window_forward() {
    assert_eq!(forward_uid_range(5), "6:*");
}

#[test]
fn sync_window_backward_resumes() {
    let conn = open_memory().unwrap();
    conn
        .execute(
            "INSERT INTO messages (message_id, thread_id, folder, uid, from_address, to_addresses, cc_addresses, subject, body_text, date, raw_path)
             VALUES (?1, ?1, ?2, 100, 's', '[]', '[]', 'T', 'B', ?3, 'x')",
            rusqlite::params![
                "m1@test",
                MAILBOX,
                "2026-02-24T08:44:52.000Z"
            ],
        )
        .unwrap();
    let oldest = oldest_message_date_for_folder(&conn, MAILBOX)
        .unwrap()
        .unwrap();
    assert_eq!(oldest, "2026-02-24T08:44:52.000Z");
}

#[test]
fn parse_since_spec() {
    let d7 = parse_since_to_date("7d").unwrap();
    assert_eq!(d7.len(), 10);
    parse_since_to_date("3m").unwrap();
    parse_since_to_date("2y").unwrap();
    parse_since_to_date("5w").unwrap();
    assert!(parse_since_to_date("0d").is_err());
    assert!(parse_since_to_date("bad").is_err());
}

#[test]
fn message_persist_roundtrip() {
    let conn = open_memory().unwrap();
    let p = ParsedMessage {
        message_id: "mid-round@test".into(),
        from_address: "a@b.com".into(),
        from_name: None,
        to_addresses: vec![],
        cc_addresses: vec![],
        subject: "S".into(),
        date: "2025-01-01T00:00:00Z".into(),
        body_text: "hello".into(),
        body_html: None,
        attachments: vec![],
        category: None,
    };
    assert!(persist_message(&conn, &p, MAILBOX, 1, "[]", "maildir/x.eml").unwrap());
    let sub: String = conn
        .query_row(
            "SELECT subject FROM messages WHERE message_id = ?1",
            ["mid-round@test"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(sub, "S");
}

#[test]
fn fts_trigger_fires_on_insert() {
    let conn = open_memory().unwrap();
    let p = ParsedMessage {
        message_id: "mid-fts@test".into(),
        from_address: "a@b.com".into(),
        from_name: None,
        to_addresses: vec![],
        cc_addresses: vec![],
        subject: "invoice paper".into(),
        date: "2025-01-02T00:00:00Z".into(),
        body_text: "invoice total".into(),
        body_html: None,
        attachments: vec![],
        category: None,
    };
    persist_message(&conn, &p, MAILBOX, 2, "[]", "y.eml").unwrap();
    let n = fts_match_count(&conn, "invoice").unwrap();
    assert!(n >= 1, "fts count {n}");
}

#[test]
fn process_lock_acquire_release() {
    let mut conn = open_memory().unwrap();
    let pid = std::process::id() as i64;
    let r = acquire_lock(&mut conn, pid).unwrap();
    assert_eq!(
        r,
        LockResult {
            acquired: true,
            taken_over: false
        }
    );
    let row: SyncLockRow = conn
        .query_row(
            "SELECT is_running, owner_pid, sync_lock_started_at FROM sync_summary WHERE id = 1",
            [],
            |row| {
                Ok(SyncLockRow {
                    is_running: row.get(0)?,
                    owner_pid: row.get(1)?,
                    sync_lock_started_at: row.get(2)?,
                })
            },
        )
        .unwrap();
    assert!(is_sync_lock_held(Some(&row)));
    release_lock(&conn, Some(pid)).unwrap();
    let row2: SyncLockRow = conn
        .query_row(
            "SELECT is_running, owner_pid, sync_lock_started_at FROM sync_summary WHERE id = 1",
            [],
            |row| {
                Ok(SyncLockRow {
                    is_running: row.get(0)?,
                    owner_pid: row.get(1)?,
                    sync_lock_started_at: row.get(2)?,
                })
            },
        )
        .unwrap();
    assert!(!is_sync_lock_held(Some(&row2)));
}

#[test]
fn process_lock_stale_pid() {
    let mut conn = open_memory().unwrap();
    conn
        .execute(
            "UPDATE sync_summary SET is_running = 1, owner_pid = 999999999, sync_lock_started_at = datetime('now') WHERE id = 1",
            [],
        )
        .unwrap();
    let r = acquire_lock(&mut conn, 12345).unwrap();
    assert!(r.acquired, "should take over dead owner");
}

#[test]
fn maildir_sidecar_written() {
    let dir = tempdir().unwrap();
    let cur = dir.path().join("cur");
    let w = write_maildir_message(
        &cur,
        "abc123",
        b"From: x@y\r\n\r\nHi",
        &["Inbox".into(), "Important".into()],
    )
    .unwrap();
    assert!(w.eml_path.exists());
    assert!(w.meta_path.exists());
    let meta: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&w.meta_path).unwrap()).unwrap();
    assert_eq!(meta["labels"][0], "Inbox");
}

#[test]
fn filter_uids_after_last() {
    assert_eq!(
        filter_uids_after(&[98, 99, 100, 101, 102], 100),
        vec![101, 102]
    );
}

#[test]
fn same_calendar_day_eq() {
    assert!(same_calendar_day(
        "2026-02-24T08:44:52.000Z",
        "2026-02-24T12:00:00.000Z"
    ));
}

#[test]
fn is_process_alive_smoke() {
    assert!(is_process_alive(std::process::id() as i32));
}
