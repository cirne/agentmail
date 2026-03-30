//! Integration tests: SMTP resolution from IMAP host, draft store, threading headers, send-test filter, dry-run.

use tempfile::tempdir;
use zmail::{
    filter_recipients_send_test, list_drafts, plan_send, read_draft, resolve_smtp_for_imap_host,
    write_draft, DraftMeta, SendPlan, SendTestMode,
};
use zmail::config::SmtpJson;

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
fn draft_store_roundtrip() {
    let dir = tempdir().unwrap();
    let meta = DraftMeta {
        to: Some("bob@x.com".into()),
        subject: Some("Hi".into()),
        cc: None,
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
        to: Some("t@t.com".into()),
        subject: Some("Subj".into()),
        cc: None,
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
