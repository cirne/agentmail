//! Message-ID and thread-ID normalization for DB lookups (RFC 5322 angle brackets).

use rusqlite::{Connection, OptionalExtension};

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
    fn normalize_message_id_adds_brackets() {
        assert_eq!(normalize_message_id("a@b"), "<a@b>");
        assert_eq!(normalize_message_id("<a@b>"), "<a@b>");
        assert_eq!(normalize_message_id("  "), "  ");
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
