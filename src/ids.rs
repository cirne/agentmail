//! Message-ID and thread-ID normalization for DB lookups (RFC 5322 angle brackets).
//!
//! **Storage / resolve:** rows keep bracketed `msg-id` form where applicable; [`normalize_message_id`]
//! and [`message_id_lookup_keys`] support lookups.
//! **JSON output:** [`message_id_for_json_output`] strips one pair of surrounding `<>` for CLI/MCP/agent ergonomics.

use rusqlite::{Connection, OptionalExtension};
use serde::{Serialize, Serializer};

/// Strip one pair of surrounding angle brackets for JSON/API output (RFC 5322 `msg-id` wire form).
/// Bare strings and odd shapes are returned trimmed; `<<id>>` becomes `<id>` after one strip.
pub fn message_id_for_json_output(id: &str) -> String {
    let t = id.trim();
    if t.len() >= 2 && t.starts_with('<') && t.ends_with('>') {
        t[1..t.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

/// Serde `serialize_with` for `String` fields (`message_id`, `thread_id`, etc.).
pub fn serialize_string_id_for_json<S>(id: &str, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    message_id_for_json_output(id).serialize(serializer)
}

/// Serde `serialize_with` for `&str` / `&'a str` fields (`serialize_with` passes `&&str`).
pub fn serialize_borrowed_str_id_for_json<S>(id: &&str, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    message_id_for_json_output(id).serialize(serializer)
}

/// Serde `serialize_with` for `&[String]` fields (`serialize_with` passes `&&[String]`).
pub fn serialize_borrowed_slice_str_ids_for_json<S>(
    ids: &&[String],
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    serialize_vec_str_ids_for_json(ids, serializer)
}

/// Serde `serialize_with` for `Option<&str>` (e.g. `in_reply_to`).
pub fn serialize_option_str_id_for_json<S>(
    id: &Option<&str>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    match id {
        None => serializer.serialize_none(),
        Some(s) => serializer.serialize_some(&message_id_for_json_output(s)),
    }
}

/// Serde `serialize_with` for `&[String]` (e.g. `references` msg-id list).
pub fn serialize_vec_str_ids_for_json<S>(ids: &[String], serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    use serde::ser::SerializeSeq;
    let mut seq = serializer.serialize_seq(Some(ids.len()))?;
    for id in ids {
        seq.serialize_element(&message_id_for_json_output(id))?;
    }
    seq.end()
}

/// Normalize for display / single-form APIs (ask tools, send): prefer bracketed storage.
pub fn normalize_message_id(id: &str) -> String {
    let t = id.trim();
    if t.is_empty() {
        return id.to_string();
    }
    if t.starts_with('<') && t.ends_with('>') {
        t.to_string()
    } else {
        format!("<{t}>")
    }
}

/// Candidate keys to try against `messages.message_id` / `thread_id` / `attachments.message_id`.
/// Prefer `<id>` first (matches synced mail), then bare `id` (fixtures and edge cases).
pub fn message_id_lookup_keys(id: &str) -> Vec<String> {
    let t = id.trim();
    if t.is_empty() {
        return vec![t.to_string()];
    }
    if t.starts_with('<') && t.ends_with('>') {
        return vec![t.to_string()];
    }
    vec![format!("<{t}>"), t.to_string()]
}

/// Keys that may appear in `attachments.message_id` when the logical message id is `canonical_mid`
/// from `messages` (handles bare vs bracketed drift between tables).
pub fn attachment_message_id_lookup_keys(canonical_mid: &str) -> Vec<String> {
    let mut keys = message_id_lookup_keys(canonical_mid);
    let bare = message_id_for_json_output(canonical_mid);
    if !keys.iter().any(|k| k == &bare) {
        keys.push(bare.clone());
    }
    let norm = normalize_message_id(&bare);
    if !keys.iter().any(|k| k == &norm) {
        keys.push(norm);
    }
    keys.sort();
    keys.dedup();
    keys
}

/// First `messages.message_id` that exists for this input (tries bracketed then bare).
pub fn resolve_message_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    for key in message_id_lookup_keys(id) {
        if let Some(mid) = conn
            .query_row(
                "SELECT message_id FROM messages WHERE message_id = ?1 LIMIT 1",
                [&key],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            return Ok(Some(mid));
        }
    }
    Ok(None)
}

/// `message_id` + `raw_path` for `zmail read` (single pass over lookup keys).
pub fn resolve_message_id_and_raw_path(
    conn: &Connection,
    id: &str,
) -> rusqlite::Result<Option<(String, String)>> {
    for key in message_id_lookup_keys(id) {
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT message_id, raw_path FROM messages WHERE message_id = ?1 LIMIT 1",
                [&key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some(pair) = row {
            return Ok(Some(pair));
        }
    }
    Ok(None)
}

/// `message_id`, `thread_id`, and `raw_path` for `zmail read --json` / MCP.
pub fn resolve_message_id_thread_and_raw_path(
    conn: &Connection,
    id: &str,
) -> rusqlite::Result<Option<(String, String, String)>> {
    for key in message_id_lookup_keys(id) {
        let row: Option<(String, String, String)> = conn
            .query_row(
                "SELECT message_id, thread_id, raw_path FROM messages WHERE message_id = ?1 LIMIT 1",
                [&key],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some(triple) = row {
            return Ok(Some(triple));
        }
    }
    Ok(None)
}

/// First `thread_id` value present on any message (tries bracketed then bare).
pub fn resolve_thread_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    for key in message_id_lookup_keys(id) {
        if let Some(tid) = conn
            .query_row(
                "SELECT thread_id FROM messages WHERE thread_id = ?1 LIMIT 1",
                [&key],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            return Ok(Some(tid));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::apply_schema;
    use rusqlite::Connection;

    #[test]
    fn lookup_keys_bracketed_only() {
        assert_eq!(message_id_lookup_keys("<a@b>"), vec!["<a@b>".to_string()]);
    }

    #[test]
    fn lookup_keys_bare_then_bracketed() {
        assert_eq!(
            message_id_lookup_keys("a@b"),
            vec!["<a@b>".to_string(), "a@b".to_string()]
        );
    }

    #[test]
    fn attachment_message_id_lookup_keys_adds_bare_when_canonical_bracketed() {
        assert_eq!(
            attachment_message_id_lookup_keys("<a@b>"),
            vec!["<a@b>".to_string(), "a@b".to_string()]
        );
    }

    #[test]
    fn normalize_message_id_adds_brackets() {
        assert_eq!(normalize_message_id("a@b"), "<a@b>");
        assert_eq!(normalize_message_id("<a@b>"), "<a@b>");
        assert_eq!(normalize_message_id("  "), "  ");
    }

    #[test]
    fn message_id_for_json_output_strips_one_pair() {
        assert_eq!(message_id_for_json_output("<a@b>"), "a@b");
        assert_eq!(message_id_for_json_output("  <a@b>  "), "a@b");
        assert_eq!(message_id_for_json_output("a@b"), "a@b");
        assert_eq!(message_id_for_json_output(""), "");
        assert_eq!(message_id_for_json_output("mid-a"), "mid-a");
    }

    #[test]
    fn message_id_for_json_output_double_brackets_one_layer() {
        assert_eq!(message_id_for_json_output("<<a@b>>"), "<a@b>");
    }

    #[test]
    fn resolve_message_id_bare_matches_bracketed_row() {
        let conn = Connection::open_in_memory().unwrap();
        apply_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO messages (message_id, thread_id, folder, uid, from_address, to_addresses, cc_addresses, subject, body_text, date, raw_path)
             VALUES ('<uuid@x>', '<uuid@x>', 'f', 1, 'a@b', '[]', '[]', 's', 'b', '2020-01-01T00:00:00Z', 'p')",
            [],
        )
        .unwrap();
        assert_eq!(
            resolve_message_id(&conn, "uuid@x").unwrap().as_deref(),
            Some("<uuid@x>")
        );
    }

    #[test]
    fn resolve_message_id_falls_back_to_unbracketed_row() {
        let conn = Connection::open_in_memory().unwrap();
        apply_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO messages (message_id, thread_id, folder, uid, from_address, to_addresses, cc_addresses, subject, body_text, date, raw_path)
             VALUES ('mid-a', 'mid-a', 'f', 1, 'a@b', '[]', '[]', 's', 'b', '2020-01-01T00:00:00Z', 'p')",
            [],
        )
        .unwrap();
        assert_eq!(
            resolve_message_id(&conn, "mid-a").unwrap().as_deref(),
            Some("mid-a")
        );
    }
}
