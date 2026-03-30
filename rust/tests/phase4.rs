//! Phase 4 — who, normalize, nicknames, infer-name, signature, phonetics, fuzzy.

use std::process::Command;

use zmail::{
    infer_name_from_address, is_noreply, name_matches_phonetically, normalize_address,
    open_memory, parse_signature_block, persist_message, who, ParsedMessage, WhoOptions,
};

const MAILBOX: &str = "[Gmail]/All Mail";

fn insert(
    conn: &rusqlite::Connection,
    mid: &str,
    from: &str,
    from_name: Option<&str>,
    to: &str,
    uid: i64,
) {
    let p = ParsedMessage {
        message_id: mid.into(),
        from_address: from.into(),
        from_name: from_name.map(String::from),
        to_addresses: serde_json::from_str(to).unwrap_or_default(),
        cc_addresses: vec![],
        subject: "s".into(),
        date: "2025-01-01T12:00:00Z".into(),
        body_text: "b".into(),
        body_html: None,
        attachments: vec![],
        is_noise: false,
    };
    persist_message(conn, &p, MAILBOX, uid, "[]", "x.eml").unwrap();
}

#[test]
fn who_top_contacts_sorted() {
    let conn = open_memory().unwrap();
    for i in 0..5 {
        insert(
            &conn,
            &format!("a{i}@t"),
            "alice@corp.com",
            Some("Alice"),
            "[]",
            i,
        );
    }
    insert(&conn, "b@t", "bob@corp.com", Some("Bob"), "[]", 10);
    let r = who(
        &conn,
        &WhoOptions {
            query: String::new(),
            limit: 10,
            include_noreply: false,
        },
    )
    .unwrap();
    assert!(!r.people.is_empty());
    assert_eq!(r.people[0].primary_address, "alice@corp.com");
}

#[test]
fn who_query_phonetic_match() {
    let conn = open_memory().unwrap();
    insert(
        &conn,
        "j1@t",
        "john.doe@example.com",
        Some("John Doe"),
        "[]",
        1,
    );
    let r = who(
        &conn,
        &WhoOptions {
            query: "Jon".into(),
            limit: 10,
            include_noreply: false,
        },
    )
    .unwrap();
    assert_eq!(r.people.len(), 1);
    assert!(r.people[0].primary_address.contains("john.doe"));
}

#[test]
fn who_query_fuzzy_match() {
    let conn = open_memory().unwrap();
    insert(
        &conn,
        "j2@t",
        "jane@example.com",
        Some("John Smith"),
        "[]",
        1,
    );
    let r = who(
        &conn,
        &WhoOptions {
            query: "Johm".into(),
            limit: 10,
            include_noreply: false,
        },
    )
    .unwrap();
    assert_eq!(r.people.len(), 1);
}

#[test]
fn noreply_detection() {
    assert!(is_noreply("noreply@company.com"));
    assert!(is_noreply("no-reply@x.org"));
    assert!(!is_noreply("alice@human.com"));
}

#[test]
fn email_normalize_lowercases_domain() {
    assert_eq!(
        normalize_address("Lewis.Cirne+tag@gmail.com"),
        "lewiscirne@gmail.com"
    );
}

#[test]
fn nickname_alias_lookup() {
    assert_eq!(zmail::canonical_first_name("Bob"), "robert");
}

#[test]
fn signature_phone_extraction() {
    let sig = "John Doe\n(512) 555-1234";
    let ex = parse_signature_block(sig, "john@example.com");
    assert!(ex.phone.is_some());
    let p = ex.phone.unwrap();
    assert!(p.contains("512") && p.contains("555") && p.contains("1234"));
}

#[test]
fn infer_name_from_local_part() {
    assert_eq!(
        infer_name_from_address("lewis.cirne@alum.dartmouth.org").as_deref(),
        Some("Lewis Cirne")
    );
    assert_eq!(
        infer_name_from_address("katelyn_cirne@icloud.com").as_deref(),
        Some("Katelyn Cirne")
    );
    assert_eq!(
        infer_name_from_address("lewisCirne@example.com").as_deref(),
        Some("Lewis Cirne")
    );
    assert_eq!(
        infer_name_from_address("alanfinley@example.com").as_deref(),
        Some("Alan Finley")
    );
    assert_eq!(
        infer_name_from_address("johnsmith@example.com").as_deref(),
        Some("John Smith")
    );
    assert_eq!(
        infer_name_from_address("abrown@somecompany.com").as_deref(),
        Some("A Brown")
    );
    assert_eq!(
        infer_name_from_address("jsmith@example.com").as_deref(),
        Some("J Smith")
    );
    assert!(infer_name_from_address("sjohnson@example.com").is_none());
    assert!(infer_name_from_address("recipient@example.com").is_none());
    assert!(infer_name_from_address("fredbrown@example.com").is_none());
    assert!(infer_name_from_address("ab@example.com").is_none());
}

#[test]
fn phonetic_jon_john() {
    assert!(name_matches_phonetically("john", "jon"));
}

#[test]
fn who_exits_zero() {
    let dir = tempfile::tempdir().unwrap();
    let bin = option_env!("CARGO_BIN_EXE_zmail").unwrap();
    let st = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args(["who", "--limit", "3"])
        .status()
        .unwrap();
    assert!(st.success());
}
