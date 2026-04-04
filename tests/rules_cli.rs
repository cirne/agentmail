use std::fs;
use std::process::Command;

use tempfile::tempdir;
use zmail::{db, persist_message, ParsedMessage};

const MAILBOX: &str = "[Gmail]/All Mail";

#[test]
fn rules_add_persists_file_and_show_reads_it() {
    let dir = tempdir().unwrap();
    let bin = env!("CARGO_BIN_EXE_zmail");
    let add = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args([
            "rules",
            "add",
            "--action",
            "ignore",
            "--from-pattern",
            r"@linkedin\.com",
        ])
        .output()
        .unwrap();
    assert!(
        add.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&add.stderr)
    );
    let added: serde_json::Value = serde_json::from_slice(&add.stdout).unwrap();
    let id = added["rule"]["id"].as_str().unwrap();
    assert_eq!(added["preview"]["available"], true);
    assert_eq!(added["preview"]["candidatesScanned"], 0);
    assert_eq!(added["rule"]["kind"], "regex");
    assert_eq!(added["rule"]["fromPattern"], r"@linkedin\.com");
    let rules_path = dir.path().join("rules.json");
    let raw = fs::read_to_string(&rules_path).unwrap();
    let file_json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        file_json["rules"][0]["fromPattern"].as_str(),
        Some(r"@linkedin\.com"),
        "persisted rules should include regex fromPattern; got: {raw}"
    );

    let show = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args(["rules", "show", id])
        .output()
        .unwrap();
    assert!(
        show.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&show.stderr)
    );
    let shown: serde_json::Value = serde_json::from_slice(&show.stdout).unwrap();
    assert_eq!(shown["value"]["id"], id);
}

#[test]
fn rules_add_requires_at_least_one_pattern() {
    let dir = tempdir().unwrap();
    let bin = env!("CARGO_BIN_EXE_zmail");
    let out = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args(["rules", "add", "--action", "ignore"])
        .output()
        .unwrap();
    assert!(
        !out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stderr),
        String::from_utf8_lossy(&out.stdout)
    );
    assert!(
        combined.contains("subject-pattern")
            || combined.contains("body-pattern")
            || combined.contains("from-pattern")
            || combined.contains("regex")
            || combined.contains("rules.json"),
        "{combined}"
    );
}

#[test]
fn rules_feedback_returns_structured_proposal() {
    let dir = tempdir().unwrap();
    let bin = env!("CARGO_BIN_EXE_zmail");
    let out = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args(["rules", "feedback", "too many shipping notifications"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["proposed"]["action"], "ignore");
    assert!(v["apply"].as_str().unwrap().contains("zmail rules add"));
}

#[test]
fn rules_edit_returns_preview_payload() {
    let dir = tempdir().unwrap();
    let bin = env!("CARGO_BIN_EXE_zmail");
    let add = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args([
            "rules",
            "add",
            "--action",
            "ignore",
            "--from-pattern",
            r"@example\.com",
            "--no-preview",
        ])
        .output()
        .unwrap();
    assert!(
        add.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&add.stderr)
    );
    let added: serde_json::Value = serde_json::from_slice(&add.stdout).unwrap();
    let id = added["rule"]["id"].as_str().unwrap();

    let edit = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args(["rules", "edit", id, "--action", "ignore", "--no-preview"])
        .output()
        .unwrap();
    assert!(
        edit.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&edit.stderr)
    );
    let edited: serde_json::Value = serde_json::from_slice(&edit.stdout).unwrap();
    assert_eq!(edited["rule"]["id"], id);
    assert_eq!(edited["rule"]["action"], "ignore");
    assert_eq!(edited["preview"]["available"], false);
}

#[test]
fn archive_cli_sets_is_archived_json() {
    let dir = tempdir().unwrap();
    let conn = db::open_file(&dir.path().join("data/zmail.db")).unwrap();
    let parsed = ParsedMessage {
        message_id: "<archive-cli@test>".into(),
        from_address: "a@b.com".into(),
        from_name: None,
        to_addresses: vec![],
        cc_addresses: vec![],
        subject: "hi".into(),
        date: "2026-01-01T00:00:00Z".into(),
        body_text: "body".into(),
        body_html: None,
        attachments: vec![],
        category: None,
    };
    persist_message(&conn, &parsed, MAILBOX, 1, "[]", "cur/x.eml").unwrap();
    drop(conn);

    let bin = env!("CARGO_BIN_EXE_zmail");
    let out = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args(["archive", "<archive-cli@test>"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );

    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["results"][0]["local"]["ok"], true);
    assert_eq!(v["results"][0]["local"]["isArchived"], true);
    assert_eq!(v["results"][0]["providerMutation"]["attempted"], false);

    let conn = db::open_file(&dir.path().join("data/zmail.db")).unwrap();
    let archived: i64 = conn
        .query_row(
            "SELECT is_archived FROM messages WHERE message_id = '<archive-cli@test>'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(archived, 1);
}

#[test]
fn rules_validate_errors_hint_reset_on_legacy_v1() {
    let dir = tempdir().unwrap();
    fs::write(
        dir.path().join("rules.json"),
        r#"{"version":1,"rules":[{"id":"a","condition":"x","action":"ignore"}],"context":[]}"#,
    )
    .unwrap();
    let bin = env!("CARGO_BIN_EXE_zmail");
    let out = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args(["rules", "validate"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stderr),
        String::from_utf8_lossy(&out.stdout)
    );
    assert!(
        combined.contains("reset-defaults") && combined.contains("rules file"),
        "got: {combined}"
    );
}

#[test]
fn rules_reset_defaults_yes_recovers_from_legacy_file() {
    let dir = tempdir().unwrap();
    fs::write(
        dir.path().join("rules.json"),
        r#"{"version":1,"rules":[{"id":"a","condition":"x","action":"ignore"}]}"#,
    )
    .unwrap();
    let bin = env!("CARGO_BIN_EXE_zmail");
    assert!(!Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args(["rules", "validate"])
        .output()
        .unwrap()
        .status
        .success());
    let reset = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args(["rules", "reset-defaults", "--yes"])
        .output()
        .unwrap();
    assert!(
        reset.status.success(),
        "{}",
        String::from_utf8_lossy(&reset.stderr)
    );
    let val = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args(["rules", "validate"])
        .output()
        .unwrap();
    assert!(
        val.status.success(),
        "{}",
        String::from_utf8_lossy(&val.stderr)
    );
}

#[test]
fn inbox_help_exposes_expected_flags() {
    let dir = tempdir().unwrap();
    let bin = env!("CARGO_BIN_EXE_zmail");
    let out = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args(["inbox", "--help"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("--thorough"));
    assert!(stdout.contains("--diagnostics"));
    assert!(stdout.contains("--text"));
    assert!(!stdout.contains("--no-update"));
    assert!(!stdout.contains("--urgent-only"));
    assert!(!stdout.contains("--replay"));
    assert!(!stdout.contains("--reclassify"));
}
