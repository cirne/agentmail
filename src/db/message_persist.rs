//! Insert messages / threads / attachments (mirrors `src/db/message-persistence.ts`).

use std::path::Path;

use rusqlite::{params, CachedStatement, Connection, Transaction};

use crate::mail_category::label_to_category;
use crate::sync::{ParsedAttachment, ParsedMessage};

const SQL_INSERT_MESSAGE: &str = "INSERT INTO messages (
      message_id, thread_id, folder, uid, labels, category, from_address, from_name,
      to_addresses, cc_addresses, subject, date, body_text, raw_path
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)";

const SQL_UPSERT_THREAD: &str = "INSERT OR REPLACE INTO threads (thread_id, subject, participant_count, message_count, last_message_at)
     VALUES (?1, ?2, 1, 1, ?3)";

const SQL_INSERT_ATTACHMENT: &str =
    "INSERT INTO attachments (message_id, filename, mime_type, size, stored_path, extracted_text)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL)";

fn mime_from_ext(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "txt" => "text/plain",
        "html" | "htm" => "text/html",
        "csv" => "text/csv",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

fn label_category(labels_json: &str) -> Option<String> {
    let Ok(arr) = serde_json::from_str::<Vec<String>>(labels_json) else {
        return None;
    };
    arr.iter()
        .find_map(|label| label_to_category(label).map(str::to_string))
}

fn message_insert_params(parsed: &ParsedMessage, labels: &str) -> (Option<String>, String, String) {
    let category = label_category(labels).or_else(|| parsed.category.clone());
    let to_json = serde_json::to_string(&parsed.to_addresses).unwrap_or_else(|_| "[]".into());
    let cc_json = serde_json::to_string(&parsed.cc_addresses).unwrap_or_else(|_| "[]".into());
    (category, to_json, cc_json)
}

pub struct RebuildWriter<'conn> {
    insert_message: CachedStatement<'conn>,
    upsert_thread: CachedStatement<'conn>,
}

impl<'conn> RebuildWriter<'conn> {
    pub fn new(tx: &'conn Transaction<'conn>) -> rusqlite::Result<Self> {
        Ok(Self {
            insert_message: tx.prepare_cached(SQL_INSERT_MESSAGE)?,
            upsert_thread: tx.prepare_cached(SQL_UPSERT_THREAD)?,
        })
    }

    /// Insert message + thread row. Returns true if a new message row was inserted.
    pub fn persist_message(
        &mut self,
        parsed: &ParsedMessage,
        mailbox: &str,
        uid: i64,
        labels: &str,
        raw_path: &str,
    ) -> rusqlite::Result<bool> {
        let (category, to_json, cc_json) = message_insert_params(parsed, labels);
        let n = self.insert_message.execute(params![
            parsed.message_id,
            parsed.message_id,
            mailbox,
            uid,
            labels,
            category,
            parsed.from_address,
            parsed.from_name,
            to_json,
            cc_json,
            parsed.subject,
            parsed.date,
            parsed.body_text,
            raw_path,
        ])?;
        if n == 0 {
            return Ok(false);
        }
        self.upsert_thread
            .execute(params![parsed.message_id, parsed.subject, parsed.date])?;
        Ok(true)
    }
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
    let (category, to_json, cc_json) = message_insert_params(parsed, labels);

    let n = conn.execute(
        SQL_INSERT_MESSAGE,
        params![
            parsed.message_id,
            parsed.message_id,
            mailbox,
            uid,
            labels,
            category,
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

/// Insert attachment metadata (`filename`, `mime_type`, `size`). Bytes stay in the raw `.eml`;
/// [`crate::attachments::read_attachment_bytes`] loads them on demand (`stored_path` empty).
pub fn persist_attachments_from_parsed(
    conn: &Connection,
    message_id: &str,
    attachments: &[ParsedAttachment],
    _maildir_path: &Path,
) -> rusqlite::Result<()> {
    if attachments.is_empty() {
        return Ok(());
    }
    for att in attachments {
        let ext = att.filename.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
        let mime = if !att.mime_type.is_empty() {
            att.mime_type.as_str()
        } else {
            mime_from_ext(ext)
        };
        conn.execute(
            SQL_INSERT_ATTACHMENT,
            params![message_id, att.filename.as_str(), mime, att.size as i64, "",],
        )?;
    }
    Ok(())
}

/// Simple FTS check: return count of rows matching FTS query.
pub fn fts_match_count(conn: &Connection, fts_query: &str) -> rusqlite::Result<i64> {
    let sql = "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH ?1";
    conn.query_row(sql, [fts_query], |row| row.get(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use crate::sync::ParsedMessage;

    #[test]
    fn label_category_maps_known_labels() {
        assert_eq!(
            label_category(r#"["Promotions"]"#),
            Some("promotional".into())
        );
        assert_eq!(label_category(r#"["\\Spam"]"#), Some("spam".into()));
        assert_eq!(label_category(r#"["Inbox"]"#), None);
    }

    #[test]
    fn persist_and_fts() {
        let conn = open_memory().unwrap();
        let p = ParsedMessage {
            message_id: "<t@1>".into(),
            from_address: "from@x.com".into(),
            from_name: None,
            to_addresses: vec!["to@y.com".into()],
            cc_addresses: vec![],
            subject: "hello world".into(),
            date: "2026-01-01T00:00:00Z".into(),
            body_text: "body content here".into(),
            body_html: None,
            attachments: vec![],
            category: None,
        };
        assert!(persist_message(&conn, &p, "INBOX", 1, "[]", "/tmp/x").unwrap());
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .unwrap();
        assert_eq!(n, 1);
        let fts = fts_match_count(&conn, "hello").unwrap();
        assert!(fts >= 1);
    }
}
