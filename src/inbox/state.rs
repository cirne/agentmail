//! Persistent inbox scan and handled-state helpers.

use rusqlite::{params, Connection};
use uuid::Uuid;

use crate::refresh::RefreshPreviewRow;

fn new_scan_id() -> String {
    Uuid::new_v4().to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedInboxDecision {
    pub message_id: String,
    pub rules_fingerprint: String,
    pub action: String,
    pub matched_rule_ids: Vec<String>,
    pub note: Option<String>,
    pub decision_source: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InboxSurfaceMode {
    #[default]
    Check,
    Review,
}

impl InboxSurfaceMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Check => "check",
            Self::Review => "review",
        }
    }

    fn table_name(self) -> &'static str {
        match self {
            Self::Check => "inbox_alerts",
            Self::Review => "inbox_reviews",
        }
    }
}

pub fn record_inbox_scan(
    conn: &Connection,
    mode: InboxSurfaceMode,
    cutoff_iso: &str,
    candidates_scanned: usize,
    surfaced_message_ids: &[String],
) -> rusqlite::Result<String> {
    let scan_id = new_scan_id();
    conn.execute(
        "INSERT INTO inbox_scans (scan_id, mode, cutoff_iso, notable_count, candidates_scanned)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            scan_id,
            mode.as_str(),
            cutoff_iso,
            surfaced_message_ids.len() as i64,
            candidates_scanned as i64
        ],
    )?;
    let insert_sql = format!(
        "INSERT OR REPLACE INTO {} (message_id, surfaced_at, scan_id)
         VALUES (?1, datetime('now'), ?2)",
        mode.table_name()
    );
    for message_id in surfaced_message_ids {
        conn.execute(&insert_sql, params![message_id, scan_id])?;
    }
    Ok(scan_id)
}

pub fn mark_message_handled(
    conn: &Connection,
    message_id: &str,
    archive: bool,
) -> rusqlite::Result<bool> {
    let exists = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM messages WHERE message_id = ?1)",
        [message_id],
        |row| row.get::<_, i64>(0),
    )? == 1;
    if !exists {
        return Ok(false);
    }

    if archive {
        conn.execute(
            "UPDATE messages SET is_archived = 1 WHERE message_id = ?1",
            [message_id],
        )?;
    }

    conn.execute(
        "INSERT OR REPLACE INTO inbox_handled (message_id, handled_at, archived)
         VALUES (?1, datetime('now'), ?2)",
        params![message_id, if archive { 1 } else { 0 }],
    )?;

    Ok(true)
}

pub fn dismiss_message(
    conn: &Connection,
    message_id: &str,
    archive: bool,
) -> rusqlite::Result<bool> {
    mark_message_handled(conn, message_id, archive)
}

pub fn already_surfaced_filter_sql(mode: InboxSurfaceMode, replay: bool) -> &'static str {
    if replay {
        ""
    } else {
        match mode {
            InboxSurfaceMode::Check => {
                " AND NOT EXISTS (SELECT 1 FROM inbox_alerts s WHERE s.message_id = messages.message_id)"
            }
            InboxSurfaceMode::Review => {
                " AND NOT EXISTS (SELECT 1 FROM inbox_reviews s WHERE s.message_id = messages.message_id)"
            }
        }
    }
}

pub fn load_cached_inbox_decisions(
    conn: &Connection,
    rules_fingerprint: &str,
    message_ids: &[String],
) -> rusqlite::Result<Vec<CachedInboxDecision>> {
    if message_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = message_ids
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT message_id, rules_fingerprint, action, matched_rule_ids, note, decision_source
         FROM inbox_decisions
         WHERE rules_fingerprint = ?1 AND message_id IN ({placeholders})"
    );
    let mut values: Vec<rusqlite::types::Value> =
        vec![rusqlite::types::Value::Text(rules_fingerprint.to_string())];
    values.extend(
        message_ids
            .iter()
            .cloned()
            .map(rusqlite::types::Value::Text),
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(values.iter()), |row| {
        let matched_rule_ids_json: String = row.get(3)?;
        Ok(CachedInboxDecision {
            message_id: row.get(0)?,
            rules_fingerprint: row.get(1)?,
            action: row.get(2)?,
            matched_rule_ids: serde_json::from_str(&matched_rule_ids_json).unwrap_or_default(),
            note: row.get(4)?,
            decision_source: row.get(5)?,
        })
    })?;
    rows.collect()
}

pub fn persist_inbox_decisions(
    conn: &Connection,
    rules_fingerprint: &str,
    rows: &[RefreshPreviewRow],
) -> rusqlite::Result<()> {
    for row in rows {
        conn.execute(
            "INSERT OR REPLACE INTO inbox_decisions
             (message_id, rules_fingerprint, action, matched_rule_ids, note, decision_source)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                row.message_id,
                rules_fingerprint,
                row.action.as_deref().unwrap_or("inform"),
                serde_json::to_string(&row.matched_rule_ids).unwrap_or_else(|_| "[]".into()),
                row.note,
                row.decision_source.as_deref().unwrap_or("fallback"),
            ],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use crate::persist_message;
    use crate::sync::ParsedMessage;

    #[test]
    fn record_scan_inserts_history_and_mode_specific_rows() {
        let conn = open_memory().unwrap();
        for (uid, mid) in [(1, "m1"), (2, "m2")] {
            let parsed = ParsedMessage {
                message_id: mid.into(),
                from_address: "a@b.com".into(),
                from_name: None,
                to_addresses: vec![],
                cc_addresses: vec![],
                subject: "s".into(),
                date: "2026-01-01T00:00:00Z".into(),
                body_text: "b".into(),
                body_html: None,
                attachments: vec![],
                category: None,
            };
            persist_message(&conn, &parsed, "INBOX", uid, "[]", "x.eml").unwrap();
        }
        let ids = vec!["m1".to_string(), "m2".to_string()];
        let scan_id = record_inbox_scan(
            &conn,
            InboxSurfaceMode::Check,
            "2026-01-01T00:00:00Z",
            5,
            &ids,
        )
        .unwrap();
        assert!(!scan_id.is_empty());
        let surfaced: i64 = conn
            .query_row("SELECT COUNT(*) FROM inbox_alerts", [], |row| row.get(0))
            .unwrap();
        let scans: i64 = conn
            .query_row("SELECT COUNT(*) FROM inbox_scans", [], |row| row.get(0))
            .unwrap();
        assert_eq!(surfaced, 2);
        assert_eq!(scans, 1);
        let mode: String = conn
            .query_row("SELECT mode FROM inbox_scans LIMIT 1", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "check");
    }

    #[test]
    fn persist_and_load_cached_decisions_roundtrip() {
        let conn = open_memory().unwrap();
        let parsed = ParsedMessage {
            message_id: "m1".into(),
            from_address: "a@b.com".into(),
            from_name: None,
            to_addresses: vec![],
            cc_addresses: vec![],
            subject: "s".into(),
            date: "2026-01-01T00:00:00Z".into(),
            body_text: "b".into(),
            body_html: None,
            attachments: vec![],
            category: None,
        };
        persist_message(&conn, &parsed, "INBOX", 1, "[]", "x.eml").unwrap();
        let row = RefreshPreviewRow {
            message_id: "m1".into(),
            date: "2026-01-01T00:00:00Z".into(),
            from_address: "a@b.com".into(),
            from_name: None,
            subject: "s".into(),
            snippet: "b".into(),
            note: Some("note".into()),
            attachments: None,
            category: None,
            action: Some("suppress".into()),
            matched_rule_ids: vec!["r1".into()],
            decision_source: Some("rule".into()),
        };
        persist_inbox_decisions(&conn, "fp1", &[row]).unwrap();
        let loaded = load_cached_inbox_decisions(&conn, "fp1", &["m1".into()]).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].action, "suppress");
        assert_eq!(loaded[0].matched_rule_ids, vec!["r1".to_string()]);
    }
}
