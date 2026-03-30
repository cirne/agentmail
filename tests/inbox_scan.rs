//! Integration tests: `run_inbox_scan` with mock classifier (mirrors `src/inbox/scan.test.ts`).

use chrono::{Duration, Utc};
use zmail::{
    inbox_candidate_prefetch_limit, open_memory, persist_message, run_inbox_scan, InboxNotablePick,
    MockInboxClassifier, ParsedMessage, RunInboxScanOptions,
};

const MAILBOX: &str = "[Gmail]/All Mail";

#[allow(clippy::too_many_arguments)]
fn insert_msg(
    conn: &rusqlite::Connection,
    mid: &str,
    from: &str,
    subject: &str,
    body: &str,
    date: &str,
    uid: i64,
    is_noise: bool,
    to_json: &str,
) {
    let p = ParsedMessage {
        message_id: mid.into(),
        from_address: from.into(),
        from_name: None,
        to_addresses: serde_json::from_str(to_json).unwrap_or_default(),
        cc_addresses: vec![],
        subject: subject.into(),
        date: date.into(),
        body_text: body.into(),
        body_html: None,
        attachments: vec![],
        is_noise,
    };
    persist_message(conn, &p, MAILBOX, uid, "[]", "x.eml").unwrap();
}

#[test]
fn prefetch_limit_matches_node() {
    assert_eq!(inbox_candidate_prefetch_limit(80), 160);
    assert_eq!(inbox_candidate_prefetch_limit(150), 200);
}

#[tokio::test]
async fn returns_rows_picked_by_classifier() {
    let conn = open_memory().unwrap();
    let old = (Utc::now() - Duration::days(10)).to_rfc3339();
    let recent = (Utc::now() - Duration::hours(2)).to_rfc3339();
    insert_msg(
        &conn, "<old@x>", "a@b.com", "Old", "body", &old, 1, false, "[]",
    );
    insert_msg(
        &conn, "<new@x>", "a@b.com", "New", "body", &recent, 2, false, "[]",
    );
    let cutoff = (Utc::now() - Duration::hours(24)).to_rfc3339();
    let mut mock = MockInboxClassifier::new(|batch| {
        batch
            .iter()
            .filter(|m| m.message_id == "<new@x>")
            .map(|m| InboxNotablePick {
                message_id: m.message_id.clone(),
                note: Some("needs reply".into()),
            })
            .collect()
    });
    let opts = RunInboxScanOptions {
        cutoff_iso: cutoff,
        include_noise: true,
        owner_address: None,
        candidate_cap: None,
        notable_cap: None,
        batch_size: None,
    };
    let r = run_inbox_scan(&conn, &opts, &mut mock).await.unwrap();
    assert_eq!(r.candidates_scanned, 1);
    assert_eq!(r.new_mail.len(), 1);
    assert_eq!(r.new_mail[0].message_id, "<new@x>");
    assert_eq!(r.new_mail[0].note.as_deref(), Some("needs reply"));
}

#[tokio::test]
async fn includes_attachment_metadata_on_notable_rows() {
    let conn = open_memory().unwrap();
    let recent = (Utc::now() - Duration::hours(2)).to_rfc3339();
    insert_msg(
        &conn, "<att@x>", "a@b.com", "Paper", "body", &recent, 1, false, "[]",
    );
    conn.execute(
        "INSERT INTO attachments (message_id, filename, mime_type, size, stored_path, extracted_text) VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
        rusqlite::params!["<att@x>", "report.pdf", "application/pdf", 3i64, "attachments/x/att/1.pdf"],
    )
    .unwrap();
    let cutoff = (Utc::now() - Duration::hours(24)).to_rfc3339();
    let mut mock = MockInboxClassifier::new(|batch| {
        batch
            .iter()
            .filter(|m| m.message_id == "<att@x>")
            .map(|m| InboxNotablePick {
                message_id: m.message_id.clone(),
                note: None,
            })
            .collect()
    });
    let opts = RunInboxScanOptions {
        cutoff_iso: cutoff,
        include_noise: true,
        owner_address: None,
        candidate_cap: None,
        notable_cap: None,
        batch_size: None,
    };
    let r = run_inbox_scan(&conn, &opts, &mut mock).await.unwrap();
    assert_eq!(r.new_mail.len(), 1);
    let atts = r.new_mail[0].attachments.as_ref().unwrap();
    assert_eq!(atts.len(), 1);
    assert_eq!(atts[0].filename, "report.pdf");
    assert_eq!(atts[0].mime_type, "application/pdf");
    assert_eq!(atts[0].index, 1);
}

#[tokio::test]
async fn orders_llm_batches_by_sender_contact_rank() {
    let conn = open_memory().unwrap();
    let owner = "me@example.com";
    let friend = "friend@example.com";
    let bulk = "bulk@example.com";
    let old = (Utc::now() - Duration::days(20)).to_rfc3339();
    let recent = (Utc::now() - Duration::hours(2)).to_rfc3339();
    for i in 0..6 {
        insert_msg(
            &conn,
            &format!("<hist-{i}@x>"),
            owner,
            "hist",
            "body",
            &old,
            100 + i,
            false,
            &format!("[\"{friend}\"]"),
        );
    }
    insert_msg(
        &conn,
        "<hist-f@x>",
        friend,
        "hist",
        "body",
        &old,
        200,
        false,
        &format!("[\"{owner}\"]"),
    );
    for i in 0..25 {
        insert_msg(
            &conn,
            &format!("<bulk-{i}@x>"),
            bulk,
            "n",
            "body",
            &recent,
            300 + i,
            false,
            &format!("[\"{owner}\"]"),
        );
    }
    insert_msg(
        &conn,
        "<f-recent@x>",
        friend,
        "from friend",
        "body",
        &recent,
        400,
        false,
        &format!("[\"{owner}\"]"),
    );
    let cutoff = (Utc::now() - Duration::hours(24)).to_rfc3339();
    let mut first_in_first_batch: Option<String> = None;
    let mut mock = MockInboxClassifier::new(|batch| {
        if first_in_first_batch.is_none() && !batch.is_empty() {
            first_in_first_batch = Some(batch[0].message_id.clone());
        }
        vec![]
    });
    let opts = RunInboxScanOptions {
        cutoff_iso: cutoff,
        include_noise: true,
        owner_address: Some(owner.into()),
        candidate_cap: None,
        notable_cap: None,
        batch_size: Some(20),
    };
    run_inbox_scan(&conn, &opts, &mut mock).await.unwrap();
    assert_eq!(first_in_first_batch.as_deref(), Some("<f-recent@x>"));
}

#[tokio::test]
async fn excludes_noise_when_include_noise_false() {
    let conn = open_memory().unwrap();
    let d1 = (Utc::now() - Duration::minutes(30)).to_rfc3339();
    let d2 = (Utc::now() - Duration::minutes(20)).to_rfc3339();
    insert_msg(
        &conn,
        "<noise@x>",
        "a@b.com",
        "Promo",
        "body",
        &d1,
        1,
        false,
        "[]",
    );
    insert_msg(
        &conn, "<real@x>", "a@b.com", "Real", "body", &d2, 2, false, "[]",
    );
    conn.execute(
        "UPDATE messages SET is_noise = 1 WHERE message_id = '<noise@x>'",
        [],
    )
    .unwrap();
    let cutoff = (Utc::now() - Duration::hours(1)).to_rfc3339();
    let mut mock = MockInboxClassifier::new(|batch| {
        assert_eq!(
            batch
                .iter()
                .map(|b| b.message_id.as_str())
                .collect::<Vec<_>>(),
            vec!["<real@x>"]
        );
        vec![InboxNotablePick {
            message_id: "<real@x>".into(),
            note: None,
        }]
    });
    let opts = RunInboxScanOptions {
        cutoff_iso: cutoff,
        include_noise: false,
        owner_address: None,
        candidate_cap: None,
        notable_cap: None,
        batch_size: None,
    };
    let r = run_inbox_scan(&conn, &opts, &mut mock).await.unwrap();
    assert_eq!(r.new_mail.len(), 1);
    assert_eq!(r.new_mail[0].message_id, "<real@x>");
}
