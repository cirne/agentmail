//! Insert messages / threads / attachments (mirrors `src/db/message-persistence.ts`).

use rusqlite::{params, Connection};

use crate::sync::ParsedMessage;

const SQL_INSERT_MESSAGE: &str = "INSERT INTO messages (
      message_id, thread_id, folder, uid, labels, is_noise, from_address, from_name,
      to_addresses, cc_addresses, subject, date, body_text, raw_path
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)";

const SQL_UPSERT_THREAD: &str = "INSERT OR REPLACE INTO threads (thread_id, subject, participant_count, message_count, last_message_at)
     VALUES (?1, ?2, 1, 1, ?3)";

fn label_noise(labels_json: &str) -> bool {
    let Ok(arr) = serde_json::from_str::<Vec<String>>(labels_json) else {
        return false;
    };
    arr.iter().any(|label| {
        let lower = label.to_lowercase();
        matches!(
            lower.as_str(),
            "promotions" | "\\promotions" | "social" | "\\social" | "forums" | "\\forums"
                | "spam" | "\\spam" | "junk" | "\\junk" | "bulk" | "\\bulk"
        ) || lower.starts_with("[superhuman]/ai/") && {
            let cat = &lower["[superhuman]/ai/".len()..];
            matches!(cat, "marketing" | "news" | "social" | "pitch")
        }
    })
}

/// Insert message + thread row. Returns true if a new message row was inserted.
pub fn persist_message(
    conn: &Connection,
    parsed: &ParsedMessage,
    mailbox: &str,
    uid: i64,
    labels: &str,
    raw_path: &str,
) -> rusqlite::Result<bool> {
    let is_noise = if parsed.is_noise || label_noise(labels) {
        1
    } else {
        0
    };
    let to_json = serde_json::to_string(&parsed.to_addresses).unwrap_or_else(|_| "[]".into());
    let cc_json = serde_json::to_string(&parsed.cc_addresses).unwrap_or_else(|_| "[]".into());

    let n = conn.execute(
        SQL_INSERT_MESSAGE,
        params![
            parsed.message_id,
            parsed.message_id,
            mailbox,
            uid,
            labels,
            is_noise,
            parsed.from_address,
            parsed.from_name,
            to_json,
            cc_json,
            parsed.subject,
            parsed.date,
            parsed.body_text,
            raw_path,
        ],
    )?;
    if n == 0 {
        return Ok(false);
    }
    conn.execute(
        SQL_UPSERT_THREAD,
        params![parsed.message_id, parsed.subject, parsed.date],
    )?;
    Ok(true)
}

/// Simple FTS check: return count of rows matching FTS query.
pub fn fts_match_count(conn: &Connection, fts_query: &str) -> rusqlite::Result<i64> {
    let sql = "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH ?1";
    conn.query_row(sql, [fts_query], |row| row.get(0))
}
