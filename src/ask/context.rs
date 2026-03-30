//! Context assembly for `zmail ask` Phase 2 (Node `assembleContext`).

use rusqlite::{Connection, OptionalExtension};
use std::collections::HashSet;
use std::path::Path;

use crate::attachments::{extract_and_cache, read_stored_file};

const DEFAULT_MAX_MESSAGES: usize = 50;
const DEFAULT_MAX_BODY_CHARS: usize = 2000;
const MAX_ATTACHMENT_SIZE_BYTES: i64 = 10 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_CHARS: usize = 50000;
const MAX_TOTAL_ATTACHMENT_CHARS: usize = 200_000;

fn should_include_attachments(question: &str) -> bool {
    let q = question.to_lowercase();
    let keywords = [
        "attachment",
        "attached",
        "file",
        "document",
        "spreadsheet",
        "excel",
        "xlsx",
        "csv",
        "pdf",
        "invoice",
        "receipt",
        "statement",
        "report",
        "quote",
        "quotation",
        "line item",
        "line items",
        "breakdown",
        "details",
        "data",
        "table",
        "funds request",
        "payment",
        "bill",
        "billing",
        "expense",
        "cost",
        "price",
        "contract",
        "agreement",
        "proposal",
        "estimate",
    ];
    keywords.iter().any(|k| q.contains(k))
}

fn should_include_attachment(
    mime_type: &str,
    size: i64,
    total_attachment_chars: usize,
    extracted_len: Option<usize>,
) -> Result<(), &'static str> {
    if size > MAX_ATTACHMENT_SIZE_BYTES {
        return Err("attachment too large");
    }
    let non_text = mime_type.starts_with("image/")
        || mime_type.starts_with("video/")
        || mime_type.starts_with("audio/");
    if non_text && size > 500 * 1024 {
        return Err("non-text attachment type");
    }
    if total_attachment_chars > MAX_TOTAL_ATTACHMENT_CHARS / 2 && size > 100 * 1024 {
        return Err("total attachment content limit approaching");
    }
    if let Some(n) = extracted_len {
        if n > MAX_EXTRACTED_TEXT_CHARS {
            return Err("extracted text too long");
        }
    }
    Ok(())
}

/// Build markdown context blob from candidate message IDs (and optional attachment ID allowlist).
pub fn assemble_context(
    conn: &Connection,
    data_dir: &Path,
    message_ids: &[String],
    specific_attachment_ids: &HashSet<i64>,
    question: &str,
    cache_extracted: bool,
    verbose: bool,
) -> rusqlite::Result<String> {
    assemble_context_inner(
        conn,
        data_dir,
        message_ids,
        specific_attachment_ids,
        question,
        cache_extracted,
        verbose,
        DEFAULT_MAX_MESSAGES,
        DEFAULT_MAX_BODY_CHARS,
    )
}

#[allow(clippy::too_many_arguments)]
#[allow(clippy::type_complexity)]
fn assemble_context_inner(
    conn: &Connection,
    data_dir: &Path,
    message_ids: &[String],
    specific_attachment_ids: &HashSet<i64>,
    question: &str,
    cache_extracted: bool,
    verbose: bool,
    max_messages: usize,
    max_body_chars: usize,
) -> rusqlite::Result<String> {
    let ids: Vec<&str> = message_ids
        .iter()
        .take(max_messages)
        .map(String::as_str)
        .collect();
    let mut parts = Vec::new();
    let process_attachments =
        !specific_attachment_ids.is_empty() || should_include_attachments(question);

    for mid in ids {
        let row: Option<(String, String, String, Option<String>, String, String, String)> = conn
            .query_row(
                "SELECT message_id, thread_id, from_address, from_name, subject, date, body_text FROM messages WHERE message_id = ?1",
                [mid],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                },
            )
            .optional()?;
        let Some((message_id, _thread_id, from_address, from_name, subject, date, body_text)) = row
        else {
            continue;
        };

        let markdown: String = body_text.chars().take(max_body_chars).collect();
        let mut attachment_content = String::new();
        let mut total_attachment_chars = 0usize;

        if process_attachments {
            let mut stmt = conn.prepare(
                "SELECT id, filename, mime_type, size, extracted_text, stored_path FROM attachments WHERE message_id = ?1 ORDER BY id",
            )?;
            let rows = stmt.query_map([&message_id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })?;

            for r in rows {
                let (id, filename, mime_type, size, extracted_text, stored_path) = r?;
                if !specific_attachment_ids.is_empty() && !specific_attachment_ids.contains(&id) {
                    continue;
                }
                if specific_attachment_ids.is_empty() {
                    let ext_len = extracted_text.as_ref().map(|s| s.len());
                    if let Err(reason) =
                        should_include_attachment(&mime_type, size, total_attachment_chars, ext_len)
                    {
                        if verbose {
                            eprintln!("zmail ask: skipping attachment {filename}: {reason}");
                        }
                        continue;
                    }
                }

                let mut text = extracted_text;
                if text.is_none() && !stored_path.is_empty() {
                    match read_stored_file(&stored_path, data_dir) {
                        Ok(bytes) => {
                            let mut t = extract_and_cache(
                                conn,
                                id,
                                &bytes,
                                &mime_type,
                                &filename,
                                cache_extracted,
                            )?;
                            if t.len() > MAX_EXTRACTED_TEXT_CHARS {
                                if verbose {
                                    eprintln!("zmail ask: truncating extracted attachment text");
                                }
                                t.truncate(MAX_EXTRACTED_TEXT_CHARS);
                                t.push_str("\n[... truncated ...]");
                            }
                            text = Some(t);
                        }
                        Err(e) => {
                            text = Some(format!("[Failed to read attachment: {e}]"));
                        }
                    }
                }

                let block = if let Some(ref t) = text {
                    let s = format!("\n--- Attachment: {filename} ({mime_type}) ---\n{t}");
                    total_attachment_chars += s.len();
                    s
                } else {
                    format!("\n--- Attachment: {filename} ({mime_type}) ---\n[Attachment not extracted]")
                };
                attachment_content.push_str(&block);
            }
        }

        let from_line = match &from_name {
            Some(n) if !n.is_empty() => format!("From: {from_address} ({n})"),
            _ => format!("From: {from_address}"),
        };

        parts.push(format!(
            "---\n{from_line}\nSubject: {subject}\nDate: {date}\n{markdown}{attachment_content}"
        ));
    }

    Ok(parts.join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_include_attachments_keyword() {
        assert!(should_include_attachments("invoice pdf"));
        assert!(!should_include_attachments("hello"));
    }
}
