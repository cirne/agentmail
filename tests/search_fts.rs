//! Integration tests: FTS keyword search, inline query operators, filter-only queries, result JSON shape.

use std::process::Command;

use zmail::{
    escape_fts5_query, open_memory, parse_search_query, persist_message,
    resolve_search_json_format, search_result_to_slim_json_row, search_with_meta, ParsedMessage,
    SearchOptions, SearchResultFormatPreference, SEARCH_AUTO_SLIM_THRESHOLD,
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
fn fts_basic_keyword() {
    let conn = open_memory().unwrap();
    insert_msg(
        &conn,
        "m1@test",
        "a@b.com",
        "Re: invoice",
        "please pay this invoice",
        "2025-01-10T12:00:00Z",
        1,
        None,
        "[]",
    );
    insert_msg(
        &conn,
        "m2@test",
        "c@d.com",
        "hello",
        "no keywords",
        "2025-01-11T12:00:00Z",
        2,
        None,
        "[]",
    );
    insert_msg(
        &conn,
        "m3@test",
        "e@f.com",
        "other",
        "invoice number 9",
        "2025-01-12T12:00:00Z",
        3,
        None,
        "[]",
    );
    let set = search_with_meta(
        &conn,
        &SearchOptions {
            query: Some("invoice".into()),
            limit: Some(20),
            ..Default::default()
        },
    )
    .unwrap();
    let ids: Vec<_> = set.results.iter().map(|r| r.message_id.as_str()).collect();
    assert!(ids.contains(&"m1@test"), "m1: {:?}", ids);
    assert!(ids.contains(&"m3@test"), "m3: {:?}", ids);
    assert!(!ids.contains(&"m2@test"));
}

#[test]
fn fts_or_query() {
    let conn = open_memory().unwrap();
    insert_msg(
        &conn,
        "a1@test",
        "x@y.com",
        "s",
        "foo only",
        "2025-02-01T12:00:00Z",
        1,
        None,
        "[]",
    );
    insert_msg(
        &conn,
        "a2@test",
        "x@y.com",
        "s",
        "bar only",
        "2025-02-02T12:00:00Z",
        2,
        None,
        "[]",
    );
    insert_msg(
        &conn,
        "a3@test",
        "x@y.com",
        "s",
        "neither",
        "2025-02-03T12:00:00Z",
        3,
        None,
        "[]",
    );
    let set = search_with_meta(
        &conn,
        &SearchOptions {
            query: Some("foo bar".into()),
            limit: Some(20),
            ..Default::default()
        },
    )
    .unwrap();
    let ids: Vec<_> = set.results.iter().map(|r| r.message_id.as_str()).collect();
    assert!(ids.contains(&"a1@test"));
    assert!(ids.contains(&"a2@test"));
    assert!(!ids.contains(&"a3@test"));
}

#[test]
fn fts_from_filter() {
    let conn = open_memory().unwrap();
    insert_msg(
        &conn,
        "b1@test",
        "alice@x.com",
        "sub",
        "secret word",
        "2025-03-01T12:00:00Z",
        1,
        None,
        "[]",
    );
    insert_msg(
        &conn,
        "b2@test",
        "bob@x.com",
        "sub",
        "secret word",
        "2025-03-02T12:00:00Z",
        2,
        None,
        "[]",
    );
    let set = search_with_meta(
        &conn,
        &SearchOptions {
            query: Some("from:alice secret".into()),
            limit: Some(20),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(set.results.len(), 1);
    assert_eq!(set.results[0].message_id, "b1@test");
}

#[test]
fn fts_date_filter_after_before() {
    let conn = open_memory().unwrap();
    insert_msg(
        &conn,
        "d1@test",
        "a@b.com",
        "s",
        "meet",
        "2025-04-01T12:00:00Z",
        1,
        None,
        "[]",
    );
    insert_msg(
        &conn,
        "d2@test",
        "a@b.com",
        "s",
        "meet",
        "2025-06-15T12:00:00Z",
        2,
        None,
        "[]",
    );
    insert_msg(
        &conn,
        "d3@test",
        "a@b.com",
        "s",
        "meet",
        "2025-08-01T12:00:00Z",
        3,
        None,
        "[]",
    );
    let set = search_with_meta(
        &conn,
        &SearchOptions {
            query: Some("after:2025-05-01 before:2025-07-01 meet".into()),
            limit: Some(20),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(set.results.len(), 1);
    assert_eq!(set.results[0].message_id, "d2@test");
}

#[test]
fn fts_empty_query_filter_only() {
    let conn = open_memory().unwrap();
    insert_msg(
        &conn,
        "f1@test",
        "vip@corp.com",
        "x",
        "body",
        "2025-05-10T12:00:00Z",
        1,
        None,
        "[]",
    );
    insert_msg(
        &conn,
        "f2@test",
        "other@corp.com",
        "x",
        "body",
        "2025-05-11T12:00:00Z",
        2,
        None,
        "[]",
    );
    let set = search_with_meta(
        &conn,
        &SearchOptions {
            query: Some("".into()),
            from_address: Some("vip".into()),
            limit: Some(20),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(set.results.len(), 1);
    assert_eq!(set.results[0].from_address, "vip@corp.com");
}

#[test]
fn fts_contact_rank_rerank() {
    let conn = open_memory().unwrap();
    let owner = "me@example.com";
    let vip = "vip@example.com";
    let low = "low@example.com";
    // Build owner → vip history (same thread boosts sent_count for vip).
    for i in 0..6 {
        insert_msg(
            &conn,
            &format!("hist{i}@test"),
            owner,
            "ping",
            "x",
            "2024-01-01T12:00:00Z",
            100 + i,
            None,
            &format!("[\"{vip}\"]"),
        );
    }
    // Two FTS matches with tied-ish content/date.
    insert_msg(
        &conn,
        "match-low@test",
        low,
        "s",
        "budget review",
        "2025-06-01T12:00:00Z",
        200,
        None,
        &format!("[\"{owner}\"]"),
    );
    insert_msg(
        &conn,
        "match-vip@test",
        vip,
        "s",
        "budget review",
        "2025-06-01T12:00:00Z",
        201,
        None,
        &format!("[\"{owner}\"]"),
    );
    let set = search_with_meta(
        &conn,
        &SearchOptions {
            query: Some("budget".into()),
            limit: Some(10),
            owner_address: Some(owner.into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        set.results.len() >= 2,
        "expected 2 results, got {}",
        set.results.len()
    );
    assert_eq!(
        set.results[0].message_id, "match-vip@test",
        "higher-contact peer should rank first: {:?}",
        set.results
    );
}

#[test]
fn fts_include_all_flag() {
    let conn = open_memory().unwrap();
    insert_msg(
        &conn,
        "n1@test",
        "a@b.com",
        "promo",
        "sale discount",
        "2025-01-01T12:00:00Z",
        1,
        Some("promotional"),
        "[]",
    );
    insert_msg(
        &conn,
        "n2@test",
        "a@b.com",
        "real",
        "sale discount",
        "2025-01-02T12:00:00Z",
        2,
        None,
        "[]",
    );
    let default_search = search_with_meta(
        &conn,
        &SearchOptions {
            query: Some("sale".into()),
            limit: Some(20),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(default_search.results.len(), 1);
    assert_eq!(default_search.results[0].message_id, "n2@test");

    let with_all = search_with_meta(
        &conn,
        &SearchOptions {
            query: Some("sale".into()),
            limit: Some(20),
            include_all: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(with_all.results.len(), 2);
}

#[test]
fn query_parse_from_inline() {
    let p = parse_search_query("from:alice@x.com budget planning");
    assert_eq!(p.from_address.as_deref(), Some("alice@x.com"));
    assert_eq!(p.query, "budget planning");
}

#[test]
fn query_parse_after_before_inline() {
    let p = parse_search_query("after:2024-01-01 before:2024-12-31 report");
    assert_eq!(p.after_date.as_deref(), Some("2024-01-01"));
    assert!(p.before_date.as_deref().unwrap().starts_with("2024-12-31"));
    assert_eq!(p.query, "report");
}

#[test]
fn query_parse_subject_inline() {
    let p = parse_search_query("subject:Q4 hello");
    assert_eq!(p.subject.as_deref(), Some("Q4"));
    assert_eq!(p.query, "hello");
}

#[test]
fn json_format_slim_vs_full() {
    assert_eq!(
        resolve_search_json_format(
            SEARCH_AUTO_SLIM_THRESHOLD + 1,
            SearchResultFormatPreference::Auto,
            true
        ),
        zmail::SearchJsonFormat::Slim
    );
    assert_eq!(
        resolve_search_json_format(
            SEARCH_AUTO_SLIM_THRESHOLD,
            SearchResultFormatPreference::Auto,
            true
        ),
        zmail::SearchJsonFormat::Full
    );
    assert_eq!(
        resolve_search_json_format(999, SearchResultFormatPreference::Full, true),
        zmail::SearchJsonFormat::Full
    );
    assert_eq!(
        resolve_search_json_format(1, SearchResultFormatPreference::Slim, true),
        zmail::SearchJsonFormat::Slim
    );
}

#[test]
fn json_slim_row_shape() {
    let r = zmail::SearchResult {
        message_id: "mid".into(),
        thread_id: "t".into(),
        from_address: "a@b.com".into(),
        from_name: Some("Ann".into()),
        subject: "Hi".into(),
        date: "2025-01-01T00:00:00Z".into(),
        snippet: "".into(),
        body_preview: "".into(),
        rank: 0.0,
    };
    let v = search_result_to_slim_json_row(&r);
    assert_eq!(v["messageId"], "mid");
    assert_eq!(v["subject"], "Hi");
    assert_eq!(v["fromName"], "Ann");
}

#[test]
fn search_result_total_matched() {
    let conn = open_memory().unwrap();
    for i in 0..15 {
        insert_msg(
            &conn,
            &format!("tm{i}@test"),
            "a@b.com",
            "s",
            "keywordalpha",
            "2025-01-01T12:00:00Z",
            i,
            None,
            "[]",
        );
    }
    let set = search_with_meta(
        &conn,
        &SearchOptions {
            query: Some("keywordalpha".into()),
            limit: Some(5),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(set.results.len(), 5);
    assert_eq!(set.total_matched, Some(15));
}

#[test]
fn fts5_special_chars_escaped() {
    let q = "foo[bar]";
    let esc = escape_fts5_query(q);
    assert!(esc.contains('"') || !esc.contains('['), "escaped: {esc}");
}

#[test]
fn search_exits_zero() {
    let dir = tempfile::tempdir().unwrap();
    let bin = env!("CARGO_BIN_EXE_zmail");
    let st = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args(["search", "anything", "--limit", "5"])
        .status()
        .unwrap();
    assert!(st.success());
}

/// BUG-034: `--json` is a no-op where JSON is already the default; agents still pass it.
#[test]
fn search_cli_accepts_json_flag() {
    let dir = tempfile::tempdir().unwrap();
    let bin = env!("CARGO_BIN_EXE_zmail");
    let out = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args(["search", "anything", "--json", "--limit", "3"])
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let s = String::from_utf8_lossy(&out.stdout);
    assert!(s.contains("\"results\""), "stdout: {s}");
}

/// BUG-034: `thread` accepts `--text` like other subcommands (default is text).
#[test]
fn thread_cli_accepts_text_flag() {
    let dir = tempfile::tempdir().unwrap();
    let bin = env!("CARGO_BIN_EXE_zmail");
    let st = Command::new(bin)
        .env("ZMAIL_HOME", dir.path())
        .args(["thread", "<no-such-thread>", "--text"])
        .status()
        .unwrap();
    assert!(st.success());
}
