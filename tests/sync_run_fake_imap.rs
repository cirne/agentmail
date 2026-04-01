//! Integration tests: `run_sync` with `FakeImapTransport` (no live IMAP).

use rusqlite::Connection;
use tempfile::tempdir;
use zmail::{
    acquire_lock, apply_schema, db, release_lock, run_sync, should_early_exit_forward,
    FakeImapTransport, FetchedMessage, ImapStatusData, SyncDirection, SyncFileLogger, SyncOptions,
    SCHEMA_VERSION,
};

fn open_temp_db(dir: &std::path::Path) -> Connection {
    let p = dir.join("data");
    std::fs::create_dir_all(&p).unwrap();
    let db_path = p.join("zmail.db");
    let conn = db::open_file(&db_path).unwrap();
    apply_schema(&conn).unwrap();
    conn
        .execute(
            "UPDATE sync_summary SET is_running = 0, owner_pid = NULL, sync_lock_started_at = NULL WHERE id = 1",
            [],
        )
        .ok();
    conn
}

#[test]
fn early_exit_forward_skips_examine_and_returns_flag() {
    let dir = tempdir().unwrap();
    let home = dir.path();
    let mut conn = open_temp_db(home);
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (folder, uidvalidity, last_uid) VALUES ('INBOX', 42, 9)",
        [],
    )
    .unwrap();

    let logger = SyncFileLogger::open(home).unwrap();
    let maildir = home.join("data").join("maildir");
    let mut fake = FakeImapTransport {
        status: ImapStatusData {
            messages: Some(9),
            uid_next: Some(10),
            uid_validity: Some(42),
        },
        uid_validity_on_examine: 99,
        search_uids: vec![999],
        fetch_batches: std::collections::VecDeque::new(),
    };
    let opts = SyncOptions {
        direction: SyncDirection::Forward,
        since_ymd: "2025-01-01".into(),
        force: false,
        progress_stderr: false,
    };
    let r = run_sync(&mut fake, &mut conn, &logger, "INBOX", &maildir, &[], &opts).unwrap();
    assert_eq!(r.synced, 0);
    assert_eq!(r.early_exit, Some(true));
    assert!(fake.fetch_batches.is_empty());
}

#[test]
fn forward_checkpoint_fetches_and_persists() {
    let dir = tempdir().unwrap();
    let home = dir.path();
    let mut conn = open_temp_db(home);
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (folder, uidvalidity, last_uid) VALUES ('INBOX', 1, 5)",
        [],
    )
    .unwrap();

    let raw = b"From: a@b.com\r\nSubject: t\r\nDate: Mon, 1 Jan 2024 12:00:00 +0000\r\nMessage-ID: <u1@test>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nHi";
    let mut fake = FakeImapTransport {
        status: ImapStatusData {
            messages: Some(99),
            uid_next: Some(100),
            uid_validity: Some(1),
        },
        uid_validity_on_examine: 1,
        search_uids: vec![6],
        fetch_batches: [vec![FetchedMessage {
            uid: 6,
            raw: raw.to_vec(),
            labels: vec![],
        }]]
        .into_iter()
        .collect(),
    };
    let logger = SyncFileLogger::open(home).unwrap();
    let maildir = home.join("data").join("maildir");
    let opts = SyncOptions {
        direction: SyncDirection::Forward,
        since_ymd: "2025-01-01".into(),
        force: false,
        progress_stderr: false,
    };
    let r = run_sync(&mut fake, &mut conn, &logger, "INBOX", &maildir, &[], &opts).unwrap();
    assert_eq!(r.synced, 1);
    assert!(r
        .new_message_ids
        .as_ref()
        .unwrap()
        .contains(&"<u1@test>".to_string()));
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn stale_db_rebuild_preserves_checkpoint_and_skips_cached_mail() {
    let dir = tempdir().unwrap();
    let home = dir.path();
    let data_dir = home.join("data");
    let maildir = data_dir.join("maildir");
    let maildir_cur = maildir.join("cur");
    std::fs::create_dir_all(&maildir_cur).unwrap();

    let raw = b"From: a@b.com\r\nSubject: rebuilt\r\nDate: Mon, 1 Jan 2024 12:00:00 +0000\r\nMessage-ID: <rebuilt-sync@test>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nHi";
    std::fs::write(maildir_cur.join("cached.eml"), raw).unwrap();

    let db_path = data_dir.join("zmail.db");
    let stale = Connection::open(&db_path).unwrap();
    apply_schema(&stale).unwrap();
    stale
        .execute(
            "INSERT INTO messages (message_id, thread_id, folder, uid, labels, category, from_address, from_name, to_addresses, cc_addresses, subject, date, body_text, raw_path)
             VALUES ('<rebuilt-sync@test>', '<rebuilt-sync@test>', 'INBOX', 5, '[]', NULL, 'a@b.com', NULL, '[]', '[]', 'rebuilt', '2024-01-01T12:00:00Z', 'Hi', 'maildir/cur/cached.eml')",
            [],
        )
        .unwrap();
    stale
        .execute(
            "INSERT OR REPLACE INTO sync_state (folder, uidvalidity, last_uid) VALUES ('INBOX', 7, 5)",
            [],
        )
        .unwrap();
    stale
        .pragma_update(None, "user_version", SCHEMA_VERSION - 1)
        .unwrap();
    drop(stale);

    let mut conn = db::open_file(&db_path).unwrap();
    let rebuilt_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rebuilt_count, 1);
    let rebuilt_state: (i64, i64) = conn
        .query_row(
            "SELECT uidvalidity, last_uid FROM sync_state WHERE folder = 'INBOX'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(rebuilt_state, (7, 5));

    let mut fake = FakeImapTransport {
        status: ImapStatusData {
            messages: Some(5),
            uid_next: Some(6),
            uid_validity: Some(7),
        },
        uid_validity_on_examine: 7,
        search_uids: vec![2, 3, 4, 5],
        fetch_batches: [vec![
            FetchedMessage {
                uid: 2,
                raw: raw.to_vec(),
                labels: vec![],
            },
            FetchedMessage {
                uid: 3,
                raw: raw.to_vec(),
                labels: vec![],
            },
            FetchedMessage {
                uid: 4,
                raw: raw.to_vec(),
                labels: vec![],
            },
            FetchedMessage {
                uid: 5,
                raw: raw.to_vec(),
                labels: vec![],
            },
        ]]
        .into_iter()
        .collect(),
    };
    let logger = SyncFileLogger::open(home).unwrap();
    let opts = SyncOptions {
        direction: SyncDirection::Forward,
        since_ymd: "2025-01-01".into(),
        force: false,
        progress_stderr: false,
    };
    let result = run_sync(&mut fake, &mut conn, &logger, "INBOX", &maildir, &[], &opts).unwrap();
    assert_eq!(result.synced, 0);
    assert_eq!(result.messages_fetched, 0);
    assert_eq!(result.early_exit, Some(true));
}

#[test]
fn pre_lock_held_returns_empty_without_imap() {
    let dir = tempdir().unwrap();
    let home = dir.path();
    let mut conn = open_temp_db(home);
    let pid = 1_i64;
    acquire_lock(&mut conn, pid).unwrap();

    let logger = SyncFileLogger::open(home).unwrap();
    let maildir = home.join("data").join("maildir");
    let mut fake = FakeImapTransport::default();
    let opts = SyncOptions {
        direction: SyncDirection::Forward,
        since_ymd: "2025-01-01".into(),
        force: false,
        progress_stderr: false,
    };
    let r = run_sync(&mut fake, &mut conn, &logger, "INBOX", &maildir, &[], &opts).unwrap();
    assert_eq!(r.synced, 0);
    assert!(r.early_exit.is_none());
    release_lock(&conn, Some(pid)).unwrap();
}

#[test]
fn backward_batch_skips_duplicate_message_id() {
    let dir = tempdir().unwrap();
    let home = dir.path();
    let mut conn = open_temp_db(home);
    conn.execute(
        "INSERT OR REPLACE INTO sync_state (folder, uidvalidity, last_uid) VALUES ('INBOX', 1, 1)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO messages (message_id, thread_id, folder, uid, labels, category, from_address, from_name, to_addresses, cc_addresses, subject, date, body_text, raw_path)
         VALUES ('<dup@test>', '<dup@test>', 'INBOX', 2, '[]', NULL, 'x@y.com', NULL, '[]', '[]', 's', '2024-01-01T00:00:00Z', 'b', 'maildir/cur/x.eml')",
        [],
    )
    .unwrap();

    let raw = b"From: x@y.com\r\nSubject: s\r\nDate: Mon, 1 Jan 2024 12:00:00 +0000\r\nMessage-ID: <dup@test>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nb";
    let mut fake = FakeImapTransport {
        status: ImapStatusData::default(),
        uid_validity_on_examine: 1,
        search_uids: vec![2],
        fetch_batches: [vec![FetchedMessage {
            uid: 2,
            raw: raw.to_vec(),
            labels: vec![],
        }]]
        .into_iter()
        .collect(),
    };
    let logger = SyncFileLogger::open(home).unwrap();
    let maildir = home.join("data").join("maildir");
    let opts = SyncOptions {
        direction: SyncDirection::Backward,
        since_ymd: "2020-01-01".into(),
        force: false,
        progress_stderr: false,
    };
    let r = run_sync(&mut fake, &mut conn, &logger, "INBOX", &maildir, &[], &opts).unwrap();
    assert_eq!(r.synced, 0);
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn should_early_exit_forward_predicate() {
    let st = Some((1u32, 9u32));
    let status = ImapStatusData {
        messages: Some(9),
        uid_next: Some(10),
        uid_validity: Some(1),
    };
    assert!(should_early_exit_forward(false, st, &status));
    assert!(!should_early_exit_forward(true, st, &status));
    let status2 = ImapStatusData {
        messages: Some(10),
        uid_next: Some(11),
        uid_validity: Some(1),
    };
    assert!(!should_early_exit_forward(false, st, &status2));
}
