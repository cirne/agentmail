//! Phase 1 checkpoint tests (see Rust port plan).

use std::collections::HashMap;
use std::process::Command;

use tempfile::tempdir;
use zmail::{journal_mode, list_user_tables, load_config, open_file, open_memory, LoadConfigOptions};

#[test]
fn schema_creates_all_tables() {
    let conn = open_memory().expect("memory db");
    let mut tables = list_user_tables(&conn).expect("list tables");
    tables.sort();
    assert!(tables.contains(&"attachments".to_string()));
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
    let bin = option_env!("CARGO_BIN_EXE_zmail").expect("CARGO_BIN_EXE_zmail set by cargo test");
    let status = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args(["status"])
        .status()
        .expect("spawn zmail");
    assert!(status.success(), "zmail status should exit 0");
}
