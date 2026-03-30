//! Integration tests: `setup` writes, env fallbacks, read/thread CLI, rebuild-index from maildir.

use std::collections::HashSet;
use std::fs;
use std::process::Command;

use tempfile::tempdir;
use zmail::{
    db, open_memory, persist_message, rebuild_from_maildir, rebuild_from_maildir_sequential,
    resolve_setup_email, search_with_meta, write_setup, write_zmail_config_and_env,
    ParsedMessage, SearchOptions, SetupArgs, WriteZmailParams,
};

const MAILBOX: &str = "[Gmail]/All Mail";

#[test]
fn setup_writes_config_json() {
    let dir = tempdir().unwrap();
    write_setup(dir.path(), "alice@test.com", "secret", None).unwrap();
    let raw = fs::read_to_string(dir.path().join("config.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["imap"]["user"], "alice@test.com");
    assert_eq!(v["sync"]["defaultSince"], "1y");
    assert_eq!(v["sync"]["mailbox"], "");
    assert_eq!(v["sync"]["excludeLabels"], serde_json::json!(["Trash", "Spam"]));
    let dotenv = fs::read_to_string(dir.path().join(".env")).unwrap();
    assert!(dotenv.contains("ZMAIL_IMAP_PASSWORD=secret"));
}

#[test]
fn write_zmail_wizard_shape_matches_node() {
    let dir = tempdir().unwrap();
    write_zmail_config_and_env(&WriteZmailParams {
        home: dir.path(),
        email: "bob@corp.example",
        password: "pw",
        openai_key: Some("sk-test"),
        imap_host: "imap.corp.example",
        imap_port: 993,
        default_since: "7d",
    })
    .unwrap();
    let raw = fs::read_to_string(dir.path().join("config.json")).unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["imap"]["host"], "imap.corp.example");
    assert_eq!(v["imap"]["port"], 993);
    assert_eq!(v["sync"]["defaultSince"], "7d");
    assert_eq!(v["sync"]["mailbox"], "");
    assert_eq!(v["sync"]["excludeLabels"], serde_json::json!(["Trash", "Spam"]));
}

#[test]
fn setup_env_var_fallback() {
    let mut env = std::collections::HashMap::new();
    env.insert("ZMAIL_EMAIL".into(), "env@user.com".into());
    let args = SetupArgs {
        email: None,
        password: Some("p".into()),
        openai_key: None,
        no_validate: true,
    };
    assert_eq!(
        resolve_setup_email(&args, &env).as_deref(),
        Some("env@user.com")
    );
}

#[test]
fn status_json_output() {
    let dir = tempdir().unwrap();
    let bin = env!("CARGO_BIN_EXE_zmail");
    let out = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args(["status", "--json"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert!(v.get("sync").is_some());
    assert!(v["sync"].get("totalMessages").is_some());
}

#[test]
fn read_message_text_output() {
    let dir = tempdir().unwrap();
    fs::create_dir_all(dir.path().join("data/cur")).unwrap();
    let eml_path = dir.path().join("data/cur/msg1.eml");
    let raw = b"From: a@b.com\r\nSubject: Hi\r\nMessage-ID: <mid-read@test>\r\nDate: Mon, 1 Jan 2024 12:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nBody line one.";
    fs::write(&eml_path, raw).unwrap();

    let db_path = dir.path().join("data/zmail.db");
    let conn = db::open_file(&db_path).unwrap();
    let p = ParsedMessage {
        message_id: "<mid-read@test>".into(),
        from_address: "a@b.com".into(),
        from_name: None,
        to_addresses: vec![],
        cc_addresses: vec![],
        subject: "Hi".into(),
        date: "2024-01-01T12:00:00Z".into(),
        body_text: "ignored".into(),
        body_html: None,
        attachments: vec![],
        is_noise: false,
    };
    let rel = "cur/msg1.eml";
    persist_message(&conn, &p, MAILBOX, 1, "[]", rel).unwrap();
    drop(conn);

    let bin = env!("CARGO_BIN_EXE_zmail");
    let out = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args(["read", "<mid-read@test>"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("Body line one"));
}

#[test]
fn rebuild_index_from_maildir() {
    let dir = tempdir().unwrap();
    let maildir = dir.path().join("maildir/cur");
    fs::create_dir_all(&maildir).unwrap();
    let eml = b"From: inv@x.com\r\nSubject: inv\r\nMessage-ID: <inv1@test>\r\nDate: Tue, 2 Jan 2024 12:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\ninvoice total 99";
    fs::write(maildir.join("a.eml"), eml).unwrap();

    let db_path = dir.path().join("zmail.db");
    let mut conn = db::open_file(&db_path).unwrap();
    let n = rebuild_from_maildir(&mut conn, &dir.path().join("maildir")).unwrap();
    assert!(n >= 1);
    let set = search_with_meta(
        &conn,
        &SearchOptions {
            query: Some("invoice".into()),
            limit: Some(10),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!set.results.is_empty());
}

#[test]
fn parallel_rebuild_correct() {
    let dir = tempdir().unwrap();
    let maildir = dir.path().join("m/cur");
    fs::create_dir_all(&maildir).unwrap();
    for i in 0..50 {
        let eml = format!(
            "From: u{i}@t.com\r\nSubject: s\r\nMessage-ID: <m{i}@test>\r\nDate: Mon, 1 Jan 2024 12:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nx{i}"
        );
        fs::write(maildir.join(format!("{i}.eml")), eml.as_bytes()).unwrap();
    }

    let mut c1 = open_memory().unwrap();
    rebuild_from_maildir(&mut c1, &dir.path().join("m")).unwrap();
    let mut c2 = open_memory().unwrap();
    rebuild_from_maildir_sequential(&mut c2, &dir.path().join("m")).unwrap();

    fn ids(conn: &rusqlite::Connection) -> HashSet<String> {
        let mut stmt = conn.prepare("SELECT message_id FROM messages").unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(|x| x.ok())
            .collect()
    }
    let a = ids(&c1);
    let b = ids(&c2);
    assert_eq!(a, b);
    assert_eq!(a.len(), 50);
}
