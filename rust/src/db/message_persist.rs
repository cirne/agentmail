//! Insert messages / threads / attachments (mirrors `src/db/message-persistence.ts`).

use std::fs::{create_dir_all, write};
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};

use crate::sync::{ParsedAttachment, ParsedMessage};

const SQL_INSERT_MESSAGE: &str = "INSERT INTO messages (
      message_id, thread_id, folder, uid, labels, is_noise, from_address, from_name,
      to_addresses, cc_addresses, subject, date, body_text, raw_path
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)";

const SQL_UPSERT_THREAD: &str = "INSERT OR REPLACE INTO threads (thread_id, subject, participant_count, message_count, last_message_at)
     VALUES (?1, ?2, 1, 1, ?3)";

const SQL_INSERT_ATTACHMENT: &str =
    "INSERT INTO attachments (message_id, filename, mime_type, size, stored_path, extracted_text)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL)";

fn sanitize_filename(filename: &str) -> String {
    filename
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\0'..='\x1f') {
                '_'
            } else {
                c
            }
        })
        .collect::<String>()
        .replace("..", "_")
}

fn ensure_unique_filename(dir: &Path, base_filename: &str) -> String {
    let sanitized = sanitize_filename(base_filename);
    let mut candidate = sanitized.clone();
    let mut counter = 1u32;
    while dir.join(&candidate).exists() {
        let (stem, ext) = if let Some(i) = candidate.rfind('.') {
            (candidate[..i].to_string(), candidate[i..].to_string())
        } else {
            (candidate.clone(), String::new())
        };
        candidate = format!("{stem}_{counter}{ext}");
        counter += 1;
    }
    candidate
}

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

fn label_noise(labels_json: &str) -> bool {
    let Ok(arr) = serde_json::from_str::<Vec<String>>(labels_json) else {
        return false;
    };
    arr.iter().any(|label| {
        let lower = label.to_lowercase();
        matches!(
            lower.as_str(),
            "promotions"
                | "\\promotions"
                | "social"
                | "\\social"
                | "forums"
                | "\\forums"
                | "spam"
                | "\\spam"
                | "junk"
                | "\\junk"
                | "bulk"
                | "\\bulk"
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

/// Write attachment bytes under `maildir_path/attachments/<message_id>/` and insert rows (sync path).
pub fn persist_attachments_from_parsed(
    conn: &Connection,
    message_id: &str,
    attachments: &[ParsedAttachment],
    maildir_path: &Path,
) -> rusqlite::Result<()> {
    if attachments.is_empty() {
        return Ok(());
    }
    let attachments_dir: PathBuf = maildir_path.join("attachments").join(message_id);
    create_dir_all(&attachments_dir)
        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;

    for att in attachments {
        let unique = ensure_unique_filename(&attachments_dir, &att.filename);
        let disk_path = attachments_dir.join(&unique);
        write(&disk_path, &att.content)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        let stored_path = format!("attachments/{message_id}/{unique}");
        let ext = unique.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
        let mime = if !att.mime_type.is_empty() {
            att.mime_type.as_str()
        } else {
            mime_from_ext(ext)
        };
        conn.execute(
            SQL_INSERT_ATTACHMENT,
            params![
                message_id,
                att.filename.as_str(),
                mime,
                att.size as i64,
                stored_path,
            ],
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
    fn label_noise_promotions() {
        assert!(label_noise(r#"["Promotions"]"#));
        assert!(label_noise(r#"["\\Spam"]"#));
        assert!(!label_noise(r#"["Inbox"]"#));
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
            is_noise: false,
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
