//! Regression: draft list/view and forward send must not require opening SQLite first
//! (BUG-030 — contention with background sync).

use std::collections::HashMap;

use tempfile::tempdir;
use zmail::draft::{run_draft, DraftCmd};
use zmail::send::{send_draft_by_id, write_draft, DraftMeta};
use zmail::{load_config, LoadConfigOptions};

fn test_config(home: &std::path::Path) -> zmail::config::Config {
    let mut env = HashMap::new();
    env.insert("ZMAIL_EMAIL".into(), "alice@example.com".into());
    env.insert("ZMAIL_IMAP_PASSWORD".into(), "secret".into());
    load_config(LoadConfigOptions {
        home: Some(home.to_path_buf()),
        env: Some(env),
    })
}

#[test]
fn run_draft_list_without_connection_succeeds() {
    let dir = tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("data").join("drafts")).unwrap();
    let cfg = test_config(dir.path());
    run_draft(
        DraftCmd::List {
            text: false,
            result_format: None,
        },
        &cfg,
        None,
    )
    .expect("draft list must not require DB");
}

#[test]
fn run_draft_view_without_connection_succeeds() {
    let dir = tempdir().unwrap();
    let data = dir.path().join("data");
    let drafts = data.join("drafts");
    std::fs::create_dir_all(&drafts).unwrap();
    let cfg = test_config(dir.path());
    let meta = DraftMeta {
        to: Some(vec!["bob@example.com".into()]),
        subject: Some("Hi".into()),
        ..Default::default()
    };
    write_draft(&drafts, "v1", &meta, "Hello\n").unwrap();
    run_draft(
        DraftCmd::View {
            id: "v1".into(),
            text: false,
            with_body: false,
        },
        &cfg,
        None,
    )
    .expect("draft view must not require DB");
}

#[test]
fn run_draft_reply_without_connection_fails_fast() {
    let dir = tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("data").join("drafts")).unwrap();
    let cfg = test_config(dir.path());
    let err = run_draft(
        DraftCmd::Reply {
            message_id: "x@y".into(),
            to: None,
            subject: None,
            body: None,
            body_file: None,
            with_body: false,
            text: false,
        },
        &cfg,
        None,
    )
    .expect_err("reply without conn is invalid");
    assert!(
        err.to_string().contains("database connection"),
        "unexpected: {err}"
    );
}

#[test]
fn send_forward_draft_dry_run_does_not_open_missing_index_db() {
    let dir = tempdir().unwrap();
    let data = dir.path().join("data");
    let drafts = data.join("drafts");
    std::fs::create_dir_all(&drafts).unwrap();
    let cfg = test_config(dir.path());
    assert!(
        !cfg.db_path().exists(),
        "regression fixture: no zmail.db — forward send must not need it"
    );
    let meta = DraftMeta {
        kind: Some("forward".into()),
        to: Some(vec!["bob@example.com".into()]),
        subject: Some("Fwd".into()),
        forward_of: Some("<orig@x>".into()),
        ..Default::default()
    };
    write_draft(&drafts, "fwd1", &meta, "Forwarded body\n").unwrap();
    let r = send_draft_by_id(&cfg, &data, "fwd1", true).expect("dry-run forward");
    assert!(r.ok);
    assert_eq!(r.dry_run, Some(true));
}
