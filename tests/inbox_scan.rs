//! Integration tests: `run_inbox_scan` with mock classifier (mirrors `src/inbox/scan.test.ts`).

use chrono::{Duration, Utc};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use zmail::{
    archive_messages_locally, inbox_candidate_prefetch_limit, open_memory, persist_message,
    run_inbox_scan, InboxNotablePick, InboxSurfaceMode, MockInboxClassifier, ParsedMessage,
    RunInboxScanOptions,
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
    category: Option<&str>,
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
        category: category.map(str::to_string),
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
        &conn, "<old@x>", "a@b.com", "Old", "body", &old, 1, None, "[]",
    );
    insert_msg(
        &conn, "<new@x>", "a@b.com", "New", "body", &recent, 2, None, "[]",
    );
    let cutoff = (Utc::now() - Duration::hours(24)).to_rfc3339();
    let mut mock = MockInboxClassifier::new(|batch| {
        batch
            .iter()
            .filter(|m| m.message_id == "<new@x>")
            .map(|m| InboxNotablePick {
                message_id: m.message_id.clone(),
                action: Some("notify".into()),
                matched_rule_ids: vec![],
                note: Some("needs reply".into()),
                decision_source: Some("model".into()),
                requires_user_action: false,
                action_summary: None,
            })
            .collect()
    });
    let opts = RunInboxScanOptions {
        surface_mode: InboxSurfaceMode::Check,
        cutoff_iso: cutoff,
        include_all: true,
        replay: false,
        reapply_llm: false,
        diagnostics: false,
        rules_fingerprint: Some("fp1".into()),
        owner_address: None,
        owner_aliases: vec![],
        candidate_cap: None,
        notable_cap: None,
        batch_size: None,
    };
    let r = run_inbox_scan(&conn, &opts, &mut mock).await.unwrap();
    assert_eq!(r.candidates_scanned, 1);
    assert_eq!(r.surfaced.len(), 1);
    assert_eq!(r.surfaced[0].message_id, "<new@x>");
    assert_eq!(r.surfaced[0].note.as_deref(), Some("needs reply"));
    assert_eq!(r.counts.notify, 1);
}

#[tokio::test]
async fn scan_increments_action_required_when_classifier_flags_todo() {
    let conn = open_memory().unwrap();
    let recent = (Utc::now() - Duration::hours(2)).to_rfc3339();
    insert_msg(
        &conn,
        "<todo@x>",
        "a@b.com",
        "Please confirm",
        "body",
        &recent,
        1,
        None,
        "[]",
    );
    let cutoff = (Utc::now() - Duration::hours(24)).to_rfc3339();
    let mut mock = MockInboxClassifier::new(|batch| {
        batch
            .iter()
            .map(|m| InboxNotablePick {
                message_id: m.message_id.clone(),
                action: Some("inform".into()),
                matched_rule_ids: vec![],
                note: None,
                decision_source: Some("model".into()),
                requires_user_action: true,
                action_summary: Some("Reply to confirm".into()),
            })
            .collect()
    });
    let opts = RunInboxScanOptions {
        surface_mode: InboxSurfaceMode::Review,
        cutoff_iso: cutoff,
        include_all: true,
        replay: false,
        reapply_llm: false,
        diagnostics: false,
        rules_fingerprint: Some("fp-todo".into()),
        owner_address: None,
        owner_aliases: vec![],
        candidate_cap: None,
        notable_cap: None,
        batch_size: None,
    };
    let r = run_inbox_scan(&conn, &opts, &mut mock).await.unwrap();
    assert_eq!(r.counts.action_required, 1);
    assert_eq!(r.counts.inform, 1);
    let row = r
        .surfaced
        .iter()
        .find(|x| x.message_id == "<todo@x>")
        .expect("surfaced row");
    assert!(row.requires_user_action);
    assert_eq!(row.action_summary.as_deref(), Some("Reply to confirm"));
}

/// Archiving removes mail from scan candidates but does not clear persisted `requires_user_action`.
#[tokio::test]
async fn archive_preserves_inbox_decision_action_flag_and_excludes_from_scan() {
    let conn = open_memory().unwrap();
    let recent = (Utc::now() - Duration::hours(2)).to_rfc3339();
    insert_msg(
        &conn,
        "<arch-flag@test>",
        "a@b.com",
        "Please reply",
        "body",
        &recent,
        1,
        None,
        "[]",
    );
    let cutoff = (Utc::now() - Duration::hours(24)).to_rfc3339();
    let fp = "fp-arch-flag";
    let mut mock = MockInboxClassifier::new(|batch| {
        batch
            .iter()
            .map(|m| InboxNotablePick {
                message_id: m.message_id.clone(),
                action: Some("inform".into()),
                matched_rule_ids: vec![],
                note: None,
                decision_source: Some("model".into()),
                requires_user_action: true,
                action_summary: Some("Reply to sender".into()),
            })
            .collect()
    });
    let opts = RunInboxScanOptions {
        surface_mode: InboxSurfaceMode::Review,
        cutoff_iso: cutoff.clone(),
        include_all: true,
        replay: false,
        reapply_llm: false,
        diagnostics: false,
        rules_fingerprint: Some(fp.into()),
        owner_address: None,
        owner_aliases: vec![],
        candidate_cap: None,
        notable_cap: None,
        batch_size: None,
    };
    let r1 = run_inbox_scan(&conn, &opts, &mut mock).await.unwrap();
    assert_eq!(r1.candidates_scanned, 1);

    let (rua, summ): (i64, Option<String>) = conn
        .query_row(
            "SELECT requires_user_action, action_summary FROM inbox_decisions WHERE message_id = '<arch-flag@test>' AND rules_fingerprint = ?1",
            [fp],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(rua, 1);
    assert_eq!(summ.as_deref(), Some("Reply to sender"));

    archive_messages_locally(&conn, &["<arch-flag@test>".into()], true).unwrap();
    let archived: i64 = conn
        .query_row(
            "SELECT is_archived FROM messages WHERE message_id = '<arch-flag@test>'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(archived, 1);

    let (rua_after, _): (i64, Option<String>) = conn
        .query_row(
            "SELECT requires_user_action, action_summary FROM inbox_decisions WHERE message_id = '<arch-flag@test>'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(rua_after, 1);

    let mut mock_skip = MockInboxClassifier::new(|batch| {
        assert!(
            batch.is_empty(),
            "archived messages must not be inbox candidates"
        );
        vec![]
    });
    let r2 = run_inbox_scan(&conn, &opts, &mut mock_skip).await.unwrap();
    assert_eq!(r2.candidates_scanned, 0);
}

/// Regression: inbox JSON shows `messageId` without angle brackets; `zmail archive` with that string
/// must set `is_archived` so the next inbox scan drops the message from candidates.
#[tokio::test]
async fn archive_with_bare_json_style_message_id_excludes_from_subsequent_inbox_scan() {
    let conn = open_memory().unwrap();
    let recent = (Utc::now() - Duration::hours(2)).to_rfc3339();
    insert_msg(
        &conn,
        "<bare-archive-inbox@test>",
        "a@b.com",
        "Subject",
        "body",
        &recent,
        1,
        None,
        "[]",
    );
    let cutoff = (Utc::now() - Duration::hours(24)).to_rfc3339();
    let fp = "fp-bare-archive-inbox";
    let mut mock = MockInboxClassifier::new(|batch| {
        batch
            .iter()
            .map(|m| InboxNotablePick {
                message_id: m.message_id.clone(),
                action: Some("inform".into()),
                matched_rule_ids: vec![],
                note: Some("note".into()),
                decision_source: Some("model".into()),
                requires_user_action: false,
                action_summary: None,
            })
            .collect()
    });
    let opts = RunInboxScanOptions {
        surface_mode: InboxSurfaceMode::Review,
        cutoff_iso: cutoff.clone(),
        include_all: true,
        replay: false,
        reapply_llm: false,
        diagnostics: false,
        rules_fingerprint: Some(fp.into()),
        owner_address: None,
        owner_aliases: vec![],
        candidate_cap: None,
        notable_cap: None,
        batch_size: None,
    };
    let r1 = run_inbox_scan(&conn, &opts, &mut mock).await.unwrap();
    assert_eq!(r1.candidates_scanned, 1);
    assert!(
        r1.surfaced
            .iter()
            .any(|r| r.message_id == "<bare-archive-inbox@test>"),
        "first inbox run should surface the message"
    );

    // Simulates: user copies `messageId` from JSON (stripped form), not the bracketed DB key.
    archive_messages_locally(&conn, &["bare-archive-inbox@test".into()], true).unwrap();
    let archived: i64 = conn
        .query_row(
            "SELECT is_archived FROM messages WHERE message_id = '<bare-archive-inbox@test>'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(archived, 1, "bare id must resolve to the indexed row");

    let mut mock_skip = MockInboxClassifier::new(|batch| {
        assert!(
            batch.is_empty(),
            "archived message must not be an inbox candidate after bare-id archive"
        );
        vec![]
    });
    let r2 = run_inbox_scan(&conn, &opts, &mut mock_skip).await.unwrap();
    assert_eq!(r2.candidates_scanned, 0);
    assert!(
        !r2.surfaced
            .iter()
            .any(|r| r.message_id == "<bare-archive-inbox@test>"),
        "second inbox run must not surface the archived message"
    );
}

#[tokio::test]
async fn includes_attachment_metadata_on_notable_rows() {
    let conn = open_memory().unwrap();
    let recent = (Utc::now() - Duration::hours(2)).to_rfc3339();
    insert_msg(
        &conn, "<att@x>", "a@b.com", "Paper", "body", &recent, 1, None, "[]",
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
                action: Some("notify".into()),
                matched_rule_ids: vec![],
                note: None,
                decision_source: Some("model".into()),
                requires_user_action: false,
                action_summary: None,
            })
            .collect()
    });
    let opts = RunInboxScanOptions {
        surface_mode: InboxSurfaceMode::Check,
        cutoff_iso: cutoff,
        include_all: true,
        replay: false,
        reapply_llm: false,
        diagnostics: false,
        rules_fingerprint: Some("fp1".into()),
        owner_address: None,
        owner_aliases: vec![],
        candidate_cap: None,
        notable_cap: None,
        batch_size: None,
    };
    let r = run_inbox_scan(&conn, &opts, &mut mock).await.unwrap();
    assert_eq!(r.surfaced.len(), 1);
    assert!(
        r.surfaced[0]
            .note
            .as_deref()
            .is_some_and(|n| n.contains("Classified as notify")),
        "{:?}",
        r.surfaced[0].note
    );
    let atts = r.surfaced[0].attachments.as_ref().unwrap();
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
            None,
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
        None,
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
            None,
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
        None,
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
        surface_mode: InboxSurfaceMode::Check,
        cutoff_iso: cutoff,
        include_all: true,
        replay: false,
        reapply_llm: false,
        diagnostics: false,
        rules_fingerprint: Some("fp1".into()),
        owner_address: Some(owner.into()),
        owner_aliases: vec![],
        candidate_cap: None,
        notable_cap: None,
        batch_size: Some(20),
    };
    run_inbox_scan(&conn, &opts, &mut mock).await.unwrap();
    assert_eq!(first_in_first_batch.as_deref(), Some("<f-recent@x>"));
}

#[tokio::test]
async fn excludes_default_categories_when_include_all_false() {
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
        Some("promotional"),
        "[]",
    );
    insert_msg(
        &conn, "<real@x>", "a@b.com", "Real", "body", &d2, 2, None, "[]",
    );
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
            action: Some("notify".into()),
            matched_rule_ids: vec![],
            note: None,
            decision_source: Some("model".into()),
            requires_user_action: false,
            action_summary: None,
        }]
    });
    let opts = RunInboxScanOptions {
        surface_mode: InboxSurfaceMode::Check,
        cutoff_iso: cutoff,
        include_all: false,
        replay: false,
        reapply_llm: false,
        diagnostics: false,
        rules_fingerprint: Some("fp1".into()),
        owner_address: None,
        owner_aliases: vec![],
        candidate_cap: None,
        notable_cap: None,
        batch_size: None,
    };
    let r = run_inbox_scan(&conn, &opts, &mut mock).await.unwrap();
    assert_eq!(r.surfaced.len(), 1);
    assert_eq!(r.surfaced[0].message_id, "<real@x>");
}

#[tokio::test]
async fn second_scan_dedups_unless_replay_is_enabled() {
    let conn = open_memory().unwrap();
    let recent = (Utc::now() - Duration::minutes(20)).to_rfc3339();
    insert_msg(
        &conn,
        "<dup@x>",
        "a@b.com",
        "Need reply",
        "body",
        &recent,
        1,
        None,
        "[]",
    );
    let cutoff = (Utc::now() - Duration::hours(1)).to_rfc3339();
    let mut first = MockInboxClassifier::new(|batch| {
        batch
            .iter()
            .map(|m| InboxNotablePick {
                message_id: m.message_id.clone(),
                action: Some("notify".into()),
                matched_rule_ids: vec![],
                note: None,
                decision_source: Some("model".into()),
                requires_user_action: false,
                action_summary: None,
            })
            .collect()
    });
    let opts = RunInboxScanOptions {
        surface_mode: InboxSurfaceMode::Check,
        cutoff_iso: cutoff.clone(),
        include_all: true,
        replay: false,
        reapply_llm: false,
        diagnostics: false,
        rules_fingerprint: Some("fp1".into()),
        owner_address: None,
        owner_aliases: vec![],
        candidate_cap: None,
        notable_cap: None,
        batch_size: None,
    };
    let first_run = run_inbox_scan(&conn, &opts, &mut first).await.unwrap();
    assert_eq!(first_run.surfaced.len(), 1);

    let mut second = MockInboxClassifier::new(|batch| {
        assert!(batch.is_empty());
        vec![]
    });
    let second_run = run_inbox_scan(&conn, &opts, &mut second).await.unwrap();
    assert!(second_run.surfaced.is_empty());

    let mut replay = MockInboxClassifier::new(|batch| {
        batch
            .iter()
            .map(|m| InboxNotablePick {
                message_id: m.message_id.clone(),
                action: Some("notify".into()),
                matched_rule_ids: vec![],
                note: None,
                decision_source: Some("model".into()),
                requires_user_action: false,
                action_summary: None,
            })
            .collect()
    });
    let replay_run = run_inbox_scan(
        &conn,
        &RunInboxScanOptions {
            replay: true,
            reapply_llm: false,
            diagnostics: false,
            ..opts
        },
        &mut replay,
    )
    .await
    .unwrap();
    assert_eq!(replay_run.surfaced.len(), 1);
}

#[tokio::test]
async fn ignore_classifications_archive_and_second_scan_skips_archived_candidate() {
    let conn = open_memory().unwrap();
    let recent = (Utc::now() - Duration::minutes(10)).to_rfc3339();
    insert_msg(
        &conn,
        "<suppress@x>",
        "bulk@x.com",
        "Promo",
        "body",
        &recent,
        1,
        None,
        "[]",
    );
    let cutoff = (Utc::now() - Duration::hours(1)).to_rfc3339();
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_first = Arc::clone(&calls);
    let mut first = MockInboxClassifier::new(move |batch| {
        calls_first.fetch_add(1, Ordering::SeqCst);
        batch
            .iter()
            .map(|m| InboxNotablePick {
                message_id: m.message_id.clone(),
                action: Some("ignore".into()),
                matched_rule_ids: vec!["promo".into()],
                note: Some("routine promo".into()),
                decision_source: Some("rule".into()),
                requires_user_action: false,
                action_summary: None,
            })
            .collect()
    });
    let opts = RunInboxScanOptions {
        surface_mode: InboxSurfaceMode::Check,
        cutoff_iso: cutoff.clone(),
        include_all: true,
        replay: true,
        reapply_llm: false,
        diagnostics: true,
        rules_fingerprint: Some("fp1".into()),
        owner_address: None,
        owner_aliases: vec![],
        candidate_cap: None,
        notable_cap: None,
        batch_size: None,
    };
    let first_run = run_inbox_scan(&conn, &opts, &mut first).await.unwrap();
    assert!(first_run.surfaced.is_empty());
    assert_eq!(first_run.processed.len(), 1);
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    let calls_second = Arc::clone(&calls);
    let mut second = MockInboxClassifier::new(move |_batch| {
        calls_second.fetch_add(1, Ordering::SeqCst);
        vec![]
    });
    let second_run = run_inbox_scan(&conn, &opts, &mut second).await.unwrap();
    assert!(second_run.surfaced.is_empty());
    assert_eq!(second_run.candidates_scanned, 0);
    assert!(second_run.processed.is_empty());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let archived: i64 = conn
        .query_row(
            "SELECT is_archived FROM messages WHERE message_id = '<suppress@x>'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(archived, 1);
}

#[tokio::test]
async fn ignore_without_archive_signals_does_not_set_is_archived() {
    let conn = open_memory().unwrap();
    let recent = (Utc::now() - Duration::minutes(10)).to_rfc3339();
    insert_msg(
        &conn,
        "<plain@x>",
        "ops@example.com",
        "Operational update",
        "Departure details in body. No marketing footer.",
        &recent,
        1,
        None,
        "[]",
    );
    let cutoff = (Utc::now() - Duration::hours(1)).to_rfc3339();
    let mut mock = MockInboxClassifier::new(|batch| {
        batch
            .iter()
            .map(|m| InboxNotablePick {
                message_id: m.message_id.clone(),
                action: Some("ignore".into()),
                matched_rule_ids: vec![],
                note: Some("model ignore".into()),
                decision_source: Some("model".into()),
                requires_user_action: false,
                action_summary: None,
            })
            .collect()
    });
    run_inbox_scan(
        &conn,
        &RunInboxScanOptions {
            surface_mode: InboxSurfaceMode::Check,
            cutoff_iso: cutoff,
            include_all: true,
            replay: true,
            reapply_llm: false,
            diagnostics: true,
            rules_fingerprint: Some("fp-archive-test".into()),
            owner_address: None,
            owner_aliases: vec![],
            candidate_cap: None,
            notable_cap: None,
            batch_size: None,
        },
        &mut mock,
    )
    .await
    .unwrap();
    let archived: i64 = conn
        .query_row(
            "SELECT is_archived FROM messages WHERE message_id = '<plain@x>'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(archived, 0);
}

#[tokio::test]
async fn reclassify_includes_archived_messages_in_scan() {
    let conn = open_memory().unwrap();
    let recent = (Utc::now() - Duration::minutes(10)).to_rfc3339();
    insert_msg(
        &conn,
        "<was-archived@x>",
        "flight@example.com",
        "Tail number",
        "Body",
        &recent,
        1,
        None,
        "[]",
    );
    conn.execute(
        "UPDATE messages SET is_archived = 1 WHERE message_id = '<was-archived@x>'",
        [],
    )
    .unwrap();
    let cutoff = (Utc::now() - Duration::hours(1)).to_rfc3339();
    let saw_archived = Arc::new(AtomicBool::new(false));
    let saw = Arc::clone(&saw_archived);
    let mut mock = MockInboxClassifier::new(move |batch| {
        if batch.iter().any(|m| m.message_id == "<was-archived@x>") {
            saw.store(true, Ordering::SeqCst);
        }
        batch
            .iter()
            .map(|m| InboxNotablePick {
                message_id: m.message_id.clone(),
                action: Some("notify".into()),
                matched_rule_ids: vec![],
                note: None,
                decision_source: Some("model".into()),
                requires_user_action: false,
                action_summary: None,
            })
            .collect()
    });
    let r = run_inbox_scan(
        &conn,
        &RunInboxScanOptions {
            surface_mode: InboxSurfaceMode::Check,
            cutoff_iso: cutoff,
            include_all: true,
            replay: true,
            reapply_llm: true,
            diagnostics: false,
            rules_fingerprint: Some("fp-reclassify-archived".into()),
            owner_address: None,
            owner_aliases: vec![],
            candidate_cap: None,
            notable_cap: None,
            batch_size: None,
        },
        &mut mock,
    )
    .await
    .unwrap();
    assert!(
        saw_archived.load(Ordering::SeqCst),
        "classifier should see archived row"
    );
    assert_eq!(r.candidates_scanned, 1);
    let archived: i64 = conn
        .query_row(
            "SELECT is_archived FROM messages WHERE message_id = '<was-archived@x>'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(archived, 0);
}

#[tokio::test]
async fn scan_without_reclassify_skips_archived_messages() {
    let conn = open_memory().unwrap();
    let recent = (Utc::now() - Duration::minutes(10)).to_rfc3339();
    insert_msg(
        &conn,
        "<only-archived@x>",
        "a@b.com",
        "Hi",
        "Body",
        &recent,
        1,
        None,
        "[]",
    );
    conn.execute(
        "UPDATE messages SET is_archived = 1 WHERE message_id = '<only-archived@x>'",
        [],
    )
    .unwrap();
    let cutoff = (Utc::now() - Duration::hours(1)).to_rfc3339();
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_c = Arc::clone(&calls);
    let mut mock = MockInboxClassifier::new(move |batch| {
        calls_c.fetch_add(1, Ordering::SeqCst);
        batch
            .iter()
            .map(|m| InboxNotablePick {
                message_id: m.message_id.clone(),
                action: Some("notify".into()),
                matched_rule_ids: vec![],
                note: None,
                decision_source: Some("model".into()),
                requires_user_action: false,
                action_summary: None,
            })
            .collect()
    });
    let r = run_inbox_scan(
        &conn,
        &RunInboxScanOptions {
            surface_mode: InboxSurfaceMode::Check,
            cutoff_iso: cutoff,
            include_all: true,
            replay: true,
            reapply_llm: false,
            diagnostics: false,
            rules_fingerprint: Some("fp-no-reclassify".into()),
            owner_address: None,
            owner_aliases: vec![],
            candidate_cap: None,
            notable_cap: None,
            batch_size: None,
        },
        &mut mock,
    )
    .await
    .unwrap();
    assert_eq!(r.candidates_scanned, 0);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn changed_rules_fingerprint_recomputes_decision() {
    let conn = open_memory().unwrap();
    let recent = (Utc::now() - Duration::minutes(10)).to_rfc3339();
    insert_msg(
        &conn,
        "<rules@x>",
        "bulk@x.com",
        "Promo",
        "body",
        &recent,
        1,
        None,
        "[]",
    );
    let cutoff = (Utc::now() - Duration::hours(1)).to_rfc3339();
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_first = Arc::clone(&calls);
    let mut first = MockInboxClassifier::new(move |batch| {
        calls_first.fetch_add(1, Ordering::SeqCst);
        batch
            .iter()
            .map(|m| InboxNotablePick {
                message_id: m.message_id.clone(),
                action: Some("ignore".into()),
                matched_rule_ids: vec![],
                note: Some("first".into()),
                decision_source: Some("model".into()),
                requires_user_action: false,
                action_summary: None,
            })
            .collect()
    });
    run_inbox_scan(
        &conn,
        &RunInboxScanOptions {
            surface_mode: InboxSurfaceMode::Check,
            cutoff_iso: cutoff.clone(),
            include_all: true,
            replay: true,
            reapply_llm: false,
            diagnostics: false,
            rules_fingerprint: Some("fp1".into()),
            owner_address: None,
            owner_aliases: vec![],
            candidate_cap: None,
            notable_cap: None,
            batch_size: None,
        },
        &mut first,
    )
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // First pass does not set is_archived (model ignore without safe-archive signals); message stays a candidate for fp2.
    conn.execute(
        "UPDATE messages SET is_archived = 0 WHERE message_id = '<rules@x>'",
        [],
    )
    .unwrap();

    let calls_second = Arc::clone(&calls);
    let mut second = MockInboxClassifier::new(move |batch| {
        calls_second.fetch_add(1, Ordering::SeqCst);
        batch
            .iter()
            .map(|m| InboxNotablePick {
                message_id: m.message_id.clone(),
                action: Some("notify".into()),
                matched_rule_ids: vec!["new".into()],
                note: Some("second".into()),
                decision_source: Some("rule".into()),
                requires_user_action: false,
                action_summary: None,
            })
            .collect()
    });
    let rerun = run_inbox_scan(
        &conn,
        &RunInboxScanOptions {
            surface_mode: InboxSurfaceMode::Check,
            cutoff_iso: cutoff,
            include_all: true,
            replay: true,
            reapply_llm: false,
            diagnostics: true,
            rules_fingerprint: Some("fp2".into()),
            owner_address: None,
            owner_aliases: vec![],
            candidate_cap: None,
            notable_cap: None,
            batch_size: None,
        },
        &mut second,
    )
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(rerun.surfaced.len(), 1);
    assert_eq!(rerun.surfaced[0].note.as_deref(), Some("second"));
}

#[tokio::test]
async fn reapply_llm_bypasses_cache_even_when_fingerprint_matches() {
    let conn = open_memory().unwrap();
    let recent = (Utc::now() - Duration::minutes(10)).to_rfc3339();
    insert_msg(
        &conn,
        "<force@x>",
        "bulk@x.com",
        "Promo",
        "body",
        &recent,
        1,
        None,
        "[]",
    );
    let cutoff = (Utc::now() - Duration::hours(1)).to_rfc3339();
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_first = Arc::clone(&calls);
    let mut first = MockInboxClassifier::new(move |batch| {
        calls_first.fetch_add(1, Ordering::SeqCst);
        batch
            .iter()
            .map(|m| InboxNotablePick {
                message_id: m.message_id.clone(),
                action: Some("notify".into()),
                matched_rule_ids: vec![],
                note: Some("first".into()),
                decision_source: Some("model".into()),
                requires_user_action: false,
                action_summary: None,
            })
            .collect()
    });
    let opts = RunInboxScanOptions {
        surface_mode: InboxSurfaceMode::Check,
        cutoff_iso: cutoff.clone(),
        include_all: true,
        replay: true,
        reapply_llm: false,
        diagnostics: false,
        rules_fingerprint: Some("fp1".into()),
        owner_address: None,
        owner_aliases: vec![],
        candidate_cap: None,
        notable_cap: None,
        batch_size: None,
    };
    run_inbox_scan(&conn, &opts, &mut first).await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    let calls_second = Arc::clone(&calls);
    let mut second = MockInboxClassifier::new(move |batch| {
        calls_second.fetch_add(1, Ordering::SeqCst);
        batch
            .iter()
            .map(|m| InboxNotablePick {
                message_id: m.message_id.clone(),
                action: Some("notify".into()),
                matched_rule_ids: vec![],
                note: Some("second".into()),
                decision_source: Some("model".into()),
                requires_user_action: false,
                action_summary: None,
            })
            .collect()
    });
    let rerun = run_inbox_scan(
        &conn,
        &RunInboxScanOptions {
            reapply_llm: true,
            diagnostics: true,
            ..opts
        },
        &mut second,
    )
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(rerun.surfaced[0].note.as_deref(), Some("second"));
}

#[test]
fn archive_messages_locally_toggles_is_archived_idempotently() {
    let conn = open_memory().unwrap();
    insert_msg(
        &conn,
        "<arch@x>",
        "a@b.com",
        "hi",
        "body",
        "2026-01-01T00:00:00Z",
        1,
        None,
        "[]",
    );
    assert_eq!(
        archive_messages_locally(&conn, &["<arch@x>".into()], true).unwrap(),
        1
    );
    let archived: i64 = conn
        .query_row(
            "SELECT is_archived FROM messages WHERE message_id = '<arch@x>'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(archived, 1);
    assert_eq!(
        archive_messages_locally(&conn, &["<arch@x>".into()], true).unwrap(),
        1
    );
    assert_eq!(
        archive_messages_locally(&conn, &["<arch@x>".into()], false).unwrap(),
        1
    );
    let archived: i64 = conn
        .query_row(
            "SELECT is_archived FROM messages WHERE message_id = '<arch@x>'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(archived, 0);
}

/// Inbox/search JSON uses `message_id_for_json_output` (no angle brackets); archive must still match DB rows.
#[test]
fn archive_messages_locally_resolves_bare_message_id() {
    let conn = open_memory().unwrap();
    insert_msg(
        &conn,
        "<bare-json@test>",
        "a@b.com",
        "hi",
        "body",
        "2026-01-01T00:00:00Z",
        1,
        None,
        "[]",
    );
    assert_eq!(
        archive_messages_locally(&conn, &["bare-json@test".into()], true).unwrap(),
        1
    );
    let archived: i64 = conn
        .query_row(
            "SELECT is_archived FROM messages WHERE message_id = '<bare-json@test>'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(archived, 1);
}

#[tokio::test]
async fn diagnostics_include_processed_ignore_and_archives_locally() {
    let conn = open_memory().unwrap();
    let recent = (Utc::now() - Duration::minutes(20)).to_rfc3339();
    insert_msg(
        &conn,
        "<archive@x>",
        "ship@example.com",
        "Tracking update",
        "body",
        &recent,
        1,
        Some("promotional"),
        "[]",
    );
    let cutoff = (Utc::now() - Duration::hours(1)).to_rfc3339();
    let mut mock = MockInboxClassifier::new(|batch| {
        batch
            .iter()
            .map(|m| InboxNotablePick {
                message_id: m.message_id.clone(),
                action: Some("archive".into()),
                matched_rule_ids: vec!["ship1".into()],
                note: Some("Routine shipping update".into()),
                decision_source: Some("rule".into()),
                requires_user_action: false,
                action_summary: None,
            })
            .collect()
    });
    let run = run_inbox_scan(
        &conn,
        &RunInboxScanOptions {
            surface_mode: InboxSurfaceMode::Check,
            cutoff_iso: cutoff,
            include_all: true,
            replay: false,
            reapply_llm: false,
            diagnostics: true,
            rules_fingerprint: Some("fp1".into()),
            owner_address: None,
            owner_aliases: vec![],
            candidate_cap: None,
            notable_cap: None,
            batch_size: None,
        },
        &mut mock,
    )
    .await
    .unwrap();
    assert!(run.surfaced.is_empty());
    assert_eq!(run.processed.len(), 1);
    assert!(run
        .processed
        .iter()
        .any(|row| row.message_id == "<archive@x>"));
    assert_eq!(run.counts.ignore, 1);

    let archived: i64 = conn
        .query_row(
            "SELECT is_archived FROM messages WHERE message_id = '<archive@x>'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(archived, 1);
}
