//! Integration tests: SMTP resolution from IMAP host, draft store, threading headers, send-test filter, dry-run.

use std::fs;
use tempfile::tempdir;
use zmail::config::SmtpJson;
use zmail::send::read_draft_in_data_dir;
use zmail::{
    db, filter_recipients_send_test, list_drafts, load_threading_from_source_message, plan_send,
    read_draft, resolve_smtp_for_imap_host, send_draft_by_id, write_draft, Config, DraftMeta,
    SendPlan, SendTestMode,
};

#[test]
fn smtp_resolve_gmail() {
    let r = resolve_smtp_for_imap_host("imap.gmail.com", None).unwrap();
    assert_eq!(r.host, "smtp.gmail.com");
    assert_eq!(r.port, 587);
}

#[test]
fn smtp_resolve_override() {
    let j = SmtpJson {
        host: Some("smtp.custom.org".into()),
        port: Some(465),
        secure: Some(true),
    };
    let r = resolve_smtp_for_imap_host("imap.gmail.com", Some(&j)).unwrap();
    assert_eq!(r.host, "smtp.custom.org");
    assert_eq!(r.port, 465);
    assert!(r.secure);
}

#[test]
fn read_draft_in_data_dir_missing_is_user_friendly() {
    let dir = tempdir().unwrap();
    let err = read_draft_in_data_dir(dir.path(), "missing-id").unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("Draft not found: missing-id"), "{msg}");
    assert!(msg.contains("draft list"), "{msg}");
}

#[test]
fn draft_store_roundtrip() {
    let dir = tempdir().unwrap();
    let meta = DraftMeta {
        to: Some(vec!["bob@x.com".into()]),
        subject: Some("Hi".into()),
        ..Default::default()
    };
    let p = write_draft(dir.path(), "abc", &meta, "Body here\n").unwrap();
    let d = read_draft(&p).unwrap();
    assert_eq!(d.id, "abc");
    assert_eq!(d.meta.subject.as_deref(), Some("Hi"));
    assert_eq!(d.body.trim(), "Body here");
}

#[test]
fn draft_list_slim_vs_full() {
    let dir = tempdir().unwrap();
    let meta = DraftMeta {
        to: Some(vec!["t@t.com".into()]),
        subject: Some("Subj".into()),
        ..Default::default()
    };
    write_draft(dir.path(), "d1", &meta, "long body text").unwrap();
    let slim = list_drafts(dir.path(), false).unwrap();
    let full = list_drafts(dir.path(), true).unwrap();
    assert!(slim[0].get("bodyPreview").is_none());
    assert!(full[0].get("bodyPreview").is_some());
}

#[test]
fn threading_inreplyto_extracted() {
    let raw = b"From: a@b\r\nIn-Reply-To: <prev-msg@test>\r\nReferences: <a@test> <b@test>\r\nSubject: Re: x\r\nMessage-ID: <cur@test>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nHi";
    let (irt, refs) = zmail::extract_threading_headers(raw);
    assert_eq!(irt.as_deref(), Some("prev-msg@test"));
    assert!(refs.contains(&"a@test".into()));
    assert!(refs.contains(&"b@test".into()));
}

#[test]
fn reply_threading_accepts_legacy_cur_raw_path_when_file_is_under_maildir() {
    let dir = tempdir().unwrap();
    let maildir_cur = dir.path().join("data/maildir/cur");
    fs::create_dir_all(&maildir_cur).unwrap();
    fs::write(
        maildir_cur.join("msg1.eml"),
        b"From: a@b\r\nMessage-ID: <orig@test>\r\nReferences: <older@test>\r\nSubject: Re: hi\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nBody",
    )
    .unwrap();

    let conn = db::open_file(&dir.path().join("data/zmail.db")).unwrap();
    conn.execute(
        "INSERT INTO messages (message_id, thread_id, folder, uid, labels, is_noise, from_address, from_name, to_addresses, cc_addresses, subject, date, body_text, raw_path)
         VALUES (?1, ?1, 'INBOX', 1, '[]', 0, 'a@b', NULL, '[]', '[]', 'Re: hi', '2024-01-01T00:00:00Z', 'Body', 'cur/msg1.eml')",
        ["<orig@test>"],
    )
    .unwrap();

    let (irt, refs) =
        load_threading_from_source_message(&conn, &dir.path().join("data"), "<orig@test>").unwrap();
    assert_eq!(irt, "<orig@test>");
    assert_eq!(refs, "<older@test> <orig@test>");
}

#[test]
fn send_reply_draft_dry_run_reads_legacy_cur_raw_path_from_maildir() {
    let dir = tempdir().unwrap();
    let data_dir = dir.path().join("data");
    let drafts_dir = data_dir.join("drafts");
    let maildir_cur = data_dir.join("maildir/cur");
    fs::create_dir_all(&drafts_dir).unwrap();
    fs::create_dir_all(&maildir_cur).unwrap();
    fs::write(
        maildir_cur.join("msg1.eml"),
        b"From: a@b\r\nMessage-ID: <orig@test>\r\nReferences: <older@test>\r\nSubject: Re: hi\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nBody",
    )
    .unwrap();

    let cfg = Config {
        imap_host: "imap.gmail.com".into(),
        imap_port: 993,
        imap_user: "agent@test".into(),
        imap_password: "secret".into(),
        smtp: resolve_smtp_for_imap_host("imap.gmail.com", None).unwrap(),
        sync_default_since: "1y".into(),
        sync_mailbox: String::new(),
        sync_exclude_labels: vec!["trash".into(), "spam".into()],
        attachments_cache_extracted_text: false,
        inbox_default_window: "24h".into(),
        data_dir: data_dir.clone(),
        db_path: data_dir.join("zmail.db"),
        maildir_path: data_dir.join("maildir"),
    };
    let conn = db::open_file(&cfg.db_path).unwrap();
    conn.execute(
        "INSERT INTO messages (message_id, thread_id, folder, uid, labels, is_noise, from_address, from_name, to_addresses, cc_addresses, subject, date, body_text, raw_path)
         VALUES (?1, ?1, 'INBOX', 1, '[]', 0, 'a@b', NULL, '[]', '[]', 'Re: hi', '2024-01-01T00:00:00Z', 'Body', 'cur/msg1.eml')",
        ["<orig@test>"],
    )
    .unwrap();
    drop(conn);

    let meta = DraftMeta {
        kind: Some("reply".into()),
        to: Some(vec!["dest@test".into()]),
        subject: Some("Re: hi".into()),
        source_message_id: Some("<orig@test>".into()),
        ..Default::default()
    };
    write_draft(&drafts_dir, "reply-test", &meta, "Body").unwrap();

    let result = send_draft_by_id(&cfg, &data_dir, "reply-test", true).unwrap();
    assert!(result.ok);
}

#[test]
fn recipients_zmail_send_test_allowlist() {
    let ok = filter_recipients_send_test(
        SendTestMode::On,
        &["safe@test.com".into()],
        &["safe@test.com".into()],
    );
    assert!(ok.is_ok());
    let bad = filter_recipients_send_test(
        SendTestMode::On,
        &["evil@test.com".into()],
        &["safe@test.com".into()],
    );
    assert!(bad.is_err());
}

#[test]
fn send_dry_run_no_smtp() {
    let p = SendPlan {
        to: vec!["x@y.com".into()],
        subject: "s".into(),
        body: "b".into(),
        dry_run: true,
    };
    assert!(plan_send(&p).is_ok());
    let p2 = SendPlan {
        dry_run: false,
        ..p
    };
    assert!(plan_send(&p2).is_err());
}
