//! Integration tests: `ask` date/year guardrails, draft rewrite stub, inbox window parsing.

use zmail::{
    ask_rejects_old_explicit_year, ask_rejects_stale_date_range, draft_rewrite_stub,
    parse_inbox_window_to_iso_cutoff,
};

#[test]
fn ask_rejects_dates_older_than_1_year() {
    assert!(ask_rejects_stale_date_range("emails from two years ago").is_err());
    assert!(ask_rejects_stale_date_range("hello inbox").is_ok());
}

#[test]
fn draft_rewrite_mock_llm() {
    let out = draft_rewrite_stub("shorter", "Hello world");
    assert!(out.contains("[edited]"));
}

#[test]
fn compose_new_draft_mock_llm() {
    let out = draft_rewrite_stub("new", "");
    assert!(out.contains("[edited]"));
}

#[test]
fn inbox_parse_window() {
    let iso = parse_inbox_window_to_iso_cutoff("2024-06-01").unwrap();
    assert!(iso.starts_with("2024-06-01T00:00:00"));
    let rolling = parse_inbox_window_to_iso_cutoff("24h").unwrap();
    assert!(rolling.contains('T'));
    assert!(parse_inbox_window_to_iso_cutoff("").is_err());
    assert!(parse_inbox_window_to_iso_cutoff("bad@@@").is_err());
}

#[test]
fn ask_rejects_explicit_old_year() {
    assert!(ask_rejects_old_explicit_year("mail in year 1999").is_err());
}
