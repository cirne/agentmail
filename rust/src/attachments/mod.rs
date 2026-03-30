//! On-demand attachment text extraction (TS `~/attachments` subset).

use calamine::{Data, Reader};
use rusqlite::Connection;
use std::io::Cursor;

/// Best-effort text/markdown extraction by MIME type.
pub fn extract_attachment(bytes: &[u8], mime: &str, _filename: &str) -> Option<String> {
    let m = mime.to_lowercase();
    match m.as_str() {
        "text/csv" | "application/csv" | "text/comma-separated-values" => {
            String::from_utf8(bytes.to_vec()).ok()
        }
        "text/html" => {
            let s = String::from_utf8(bytes.to_vec()).ok()?;
            htmd::convert(&s).ok()
        }
        "text/plain" => String::from_utf8(bytes.to_vec()).ok(),
        "application/pdf" => pdf_extract::extract_text_from_mem(bytes).ok(),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => xlsx_to_csv(bytes),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => {
            docx_to_text(bytes)
        }
        _ => None,
    }
}

fn xlsx_to_csv(bytes: &[u8]) -> Option<String> {
    let mut wb = calamine::open_workbook_auto_from_rs(Cursor::new(bytes)).ok()?;
    let name = wb.sheet_names().first()?.clone();
    let range = wb.worksheet_range(&name).ok()?;
    let mut out = String::new();
    for row in range.rows() {
        let parts: Vec<String> = row.iter().map(|c| format_cell(c)).collect();
        out.push_str(&parts.join(","));
        out.push('\n');
    }
    Some(out)
}

fn format_cell(c: &Data) -> String {
    match c {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) => f.to_string(),
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::Error(e) => format!("{e:?}"),
        Data::DateTime(dt) => dt.to_string(),
        Data::DateTimeIso(s) => s.clone(),
        Data::DurationIso(s) => s.clone(),
    }
}

fn docx_to_text(bytes: &[u8]) -> Option<String> {
    let doc = docx_rs::read_docx(bytes).ok()?;
    let mut out = String::new();
    for child in doc.document.children {
        if let docx_rs::DocumentChild::Paragraph(p) = child {
            for r in p.children {
                if let docx_rs::ParagraphChild::Run(run) = r {
                    for c in run.children {
                        if let docx_rs::RunChild::Text(t) = c {
                            out.push_str(&t.text);
                        }
                    }
                }
            }
            out.push('\n');
        }
    }
    let t = out.trim().to_string();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentListRow {
    pub id: i64,
    pub filename: String,
    pub mime_type: String,
    pub size: i64,
    pub extracted: bool,
    pub index: i64,
}

pub fn list_attachments_for_message(conn: &Connection, message_id: &str) -> rusqlite::Result<Vec<AttachmentListRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, filename, mime_type, size, extracted_text FROM attachments WHERE message_id = ?1 ORDER BY id",
    )?;
    let rows = stmt.query_map([message_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    })?;
    let mut out = Vec::new();
    for (i, r) in rows.enumerate() {
        let (id, filename, mime_type, size, ext) = r?;
        out.push(AttachmentListRow {
            id,
            filename,
            mime_type,
            size,
            extracted: ext.is_some(),
            index: (i + 1) as i64,
        });
    }
    Ok(out)
}

/// Read attachment bytes from `stored_path` (absolute or relative to `data_dir`).
pub fn read_stored_file(stored_path: &str, data_dir: &std::path::Path) -> std::io::Result<Vec<u8>> {
    let p = if std::path::Path::new(stored_path).is_absolute() {
        std::path::PathBuf::from(stored_path)
    } else {
        data_dir.join(stored_path)
    };
    std::fs::read(p)
}

/// Extract text, optionally persist to `attachments.extracted_text`.
pub fn extract_and_cache(
    conn: &Connection,
    attachment_id: i64,
    bytes: &[u8],
    mime: &str,
    filename: &str,
    cache: bool,
) -> rusqlite::Result<Option<String>> {
    let text = extract_attachment(bytes, mime, filename);
    if cache {
        if let Some(ref t) = text {
            conn.execute(
                "UPDATE attachments SET extracted_text = ?1 WHERE id = ?2",
                rusqlite::params![t, attachment_id],
            )?;
        }
    }
    Ok(text)
}
