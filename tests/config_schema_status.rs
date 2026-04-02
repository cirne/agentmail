//! Integration tests: config loading, SQLite schema, FTS/WAL, `zmail status` CLI.

use std::collections::HashMap;
use std::fs;
use std::process::Command;

use tempfile::tempdir;
use zmail::{
    journal_mode, list_user_tables, load_config, open_file, open_memory, persist_message,
    LoadConfigOptions, ParsedMessage,
};

#[test]
fn schema_creates_all_tables() {
    let conn = open_memory().expect("memory db");
    let mut tables = list_user_tables(&conn).expect("list tables");
    tables.sort();
    assert!(tables.contains(&"attachments".to_string()));
    assert!(tables.contains(&"inbox_alerts".to_string()));
    assert!(tables.contains(&"inbox_scans".to_string()));
    assert!(tables.contains(&"inbox_decisions".to_string()));
    assert!(tables.contains(&"inbox_reviews".to_string()));
    assert!(tables.contains(&"messages".to_string()));
    assert!(tables.contains(&"messages_fts".to_string()));
    assert!(tables.contains(&"people".to_string()));
    assert!(tables.contains(&"sync_state".to_string()));
    assert!(tables.contains(&"sync_summary".to_string()));
    assert!(tables.contains(&"sync_windows".to_string()));
    assert!(tables.contains(&"threads".to_string()));
}

#[test]
fn fts5_virtual_table_created() {
    let conn = open_memory().expect("memory db");
    conn.execute("SELECT * FROM messages_fts LIMIT 0", [])
        .expect("messages_fts query");
}

#[test]
fn wal_mode_enabled() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join("zmail.db");
    let conn = open_file(&db_path).expect("open file");
    drop(conn);
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    let mode = journal_mode(&conn).unwrap();
    assert_eq!(mode, "wal");
}

#[test]
fn config_loads_defaults() {
    let dir = tempdir().unwrap();
    let cfg = load_config(LoadConfigOptions {
        home: Some(dir.path().to_path_buf()),
        env: Some(HashMap::new()),
    });
    assert_eq!(cfg.imap_host, "imap.gmail.com");
    assert_eq!(cfg.imap_port, 993);
    assert_eq!(cfg.sync_default_since, "1y");
    assert_eq!(cfg.inbox_default_window, "24h");
    assert_eq!(cfg.smtp.host, "smtp.gmail.com");
    assert_eq!(cfg.smtp.port, 587);
}

#[test]
fn config_reads_env_overrides() {
    let dir = tempdir().unwrap();
    let mut env = HashMap::new();
    env.insert("ZMAIL_EMAIL".into(), "alice@example.com".into());
    env.insert("ZMAIL_IMAP_PASSWORD".into(), "secret".into());
    let cfg = load_config(LoadConfigOptions {
        home: Some(dir.path().to_path_buf()),
        env: Some(env),
    });
    assert_eq!(cfg.imap_user, "alice@example.com");
    assert_eq!(cfg.imap_password, "secret");
}

#[test]
fn status_exits_zero() {
    let dir = tempdir().unwrap();
    let bin = env!("CARGO_BIN_EXE_zmail");
    let status = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args(["status"])
        .status()
        .expect("spawn zmail");
    assert!(status.success(), "zmail status should exit 0");
}

#[test]
fn check_help_mentions_verbose_flag() {
    let bin = env!("CARGO_BIN_EXE_zmail");
    let out = Command::new(bin)
        .args(["check", "--help"])
        .output()
        .expect("spawn zmail check --help");
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("--verbose"));
    assert!(stdout.contains("--watch"));
}

#[test]
fn status_text_shows_earliest_and_latest_timestamps() {
    let dir = tempdir().unwrap();
    fs::create_dir_all(dir.path().join("data")).unwrap();
    let db_path = dir.path().join("data/zmail.db");
    let conn = open_file(&db_path).unwrap();
    let first = ParsedMessage {
        message_id: "<early@test>".into(),
        from_address: "a@b.com".into(),
        from_name: None,
        to_addresses: vec![],
        cc_addresses: vec![],
        subject: "early".into(),
        date: "2024-01-01T12:00:00Z".into(),
        body_text: "body".into(),
        body_html: None,
        attachments: vec![],
        category: None,
    };
    let last = ParsedMessage {
        message_id: "<late@test>".into(),
        from_address: "a@b.com".into(),
        from_name: None,
        to_addresses: vec![],
        cc_addresses: vec![],
        subject: "late".into(),
        date: "2025-06-15T08:30:00Z".into(),
        body_text: "body".into(),
        body_html: None,
        attachments: vec![],
        category: None,
    };
    persist_message(&conn, &first, "[Gmail]/All Mail", 1, "[]", "cur/1.eml").unwrap();
    persist_message(&conn, &last, "[Gmail]/All Mail", 2, "[]", "cur/2.eml").unwrap();
    drop(conn);

    let bin = env!("CARGO_BIN_EXE_zmail");
    let out = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args(["status"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("Earliest:"));
    assert!(stdout.contains("2024-01-01T12:00:00Z"));
    assert!(stdout.contains("Latest:"));
    assert!(stdout.contains("2025-06-15T08:30:00Z"));
}
