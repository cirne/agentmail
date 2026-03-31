//! On-demand attachment text extraction (TS `~/attachments` subset).

use calamine::{Data, Reader};
use rusqlite::Connection;
use std::io::Cursor;

/// Best-effort text/markdown extraction by MIME type and filename (same order as Node extractors).
pub fn extract_attachment(bytes: &[u8], mime: &str, filename: &str) -> Option<String> {
    let m = mime.to_lowercase();
    let name = filename.to_lowercase();

    // PDF — MIME only (matches Node PdfExtractor)
    if m == "application/pdf" {
        return pdf_extract::extract_text_from_mem(bytes).ok();
    }

    // DOCX
    if m == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        || name.ends_with(".docx")
    {
        return docx_to_text(bytes);
    }

    // XLSX / XLS
    if m == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        || m == "application/vnd.ms-excel"
        || name.ends_with(".xlsx")
        || name.ends_with(".xls")
    {
        return xlsx_to_csv(bytes);
    }

    // CSV
    if m == "text/csv"
        || m == "application/csv"
        || m == "text/comma-separated-values"
        || name.ends_with(".csv")
    {
        return String::from_utf8(bytes.to_vec()).ok();
    }

    // HTML
    if m == "text/html" || name.ends_with(".html") || name.ends_with(".htm") {
        let s = String::from_utf8(bytes.to_vec()).ok()?;
        return htmd::convert(&s).ok();
    }

    // Plain text
    if m == "text/plain" || name.ends_with(".txt") {
        return String::from_utf8(bytes.to_vec()).ok();
    }

    None
}

fn mime_binary_stub(filename: &str, size_bytes: usize) -> String {
    let size_mb = size_bytes as f64 / (1024.0 * 1024.0);
    format!(
        "[Binary attachment: {filename}, {:.2} MB — no text extraction available]",
        size_mb
    )
}

fn escape_csv_field(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn xlsx_to_csv(bytes: &[u8]) -> Option<String> {
    let mut wb = calamine::open_workbook_auto_from_rs(Cursor::new(bytes)).ok()?;
    let names = wb.sheet_names().to_vec();
    if names.is_empty() {
        return None;
    }
    let multi = names.len() > 1;
    let mut sheets_out = Vec::new();
    for name in &names {
        let range = wb.worksheet_range(name).ok()?;
        let mut rows = Vec::new();
        for row in range.rows() {
            let parts: Vec<String> = row
                .iter()
                .map(|c| escape_csv_field(&format_cell(c)))
                .collect();
            rows.push(parts.join(","));
        }
        let body = rows.join("\n");
        if multi {
            sheets_out.push(format!("## Sheet: {name}\n\n{body}"));
        } else {
            sheets_out.push(body);
        }
    }
    Some(sheets_out.join("\n\n"))
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

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentListRow {
    pub id: i64,
    pub filename: String,
    pub mime_type: String,
    pub size: i64,
    pub extracted: bool,
    pub index: i64,
    /// Relative path under maildir (not part of Node list JSON; used by CLI `attachment read`).
    #[serde(skip_serializing)]
    pub stored_path: String,
}

pub fn list_attachments_for_message(
    conn: &Connection,
    message_id: &str,
) -> rusqlite::Result<Vec<AttachmentListRow>> {
    let Some(mid) = crate::ids::resolve_message_id(conn, message_id)? else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT id, filename, mime_type, size, extracted_text, stored_path FROM attachments WHERE message_id = ?1 ORDER BY id",
    )?;
    let rows = stmt.query_map([&mid], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, String>(5)?,
        ))
    })?;
    let mut out = Vec::new();
    for (i, r) in rows.enumerate() {
        let (id, filename, mime_type, size, ext, stored_path) = r?;
        out.push(AttachmentListRow {
            id,
            filename,
            mime_type,
            size,
            extracted: ext.is_some(),
            index: (i + 1) as i64,
            stored_path,
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

/// Extract text (or MIME-style stub), optionally persist to `attachments.extracted_text`.
pub fn extract_and_cache(
    conn: &Connection,
    attachment_id: i64,
    bytes: &[u8],
    mime: &str,
    filename: &str,
    cache: bool,
) -> rusqlite::Result<String> {
    let text = extract_attachment(bytes, mime, filename)
        .unwrap_or_else(|| mime_binary_stub(filename, bytes.len()));
    if cache {
        conn.execute(
            "UPDATE attachments SET extracted_text = ?1 WHERE id = ?2",
            rusqlite::params![&text, attachment_id],
        )?;
    }
    Ok(text)
}

/// Read extracted text (with cache behavior aligned to Node `extractAndCache`).
pub fn read_attachment_text(
    conn: &Connection,
    data_dir: &std::path::Path,
    attachment_id: i64,
    cache_extracted: bool,
    no_cache: bool,
) -> Result<String, String> {
    if no_cache {
        conn.execute(
            "UPDATE attachments SET extracted_text = NULL WHERE id = ?1",
            [attachment_id],
        )
        .map_err(|e| e.to_string())?;
    }

    let (filename, mime, stored_path, extracted_text): (String, String, String, Option<String>) = conn
        .query_row(
            "SELECT filename, mime_type, stored_path, extracted_text FROM attachments WHERE id = ?1",
            [attachment_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;

    let use_cached =
        cache_extracted && !no_cache && extracted_text.as_ref().is_some_and(|s| !s.is_empty());
    if use_cached {
        return Ok(extracted_text.unwrap());
    }

    let bytes = read_stored_file(&stored_path, data_dir).map_err(|e| e.to_string())?;
    extract_and_cache(
        conn,
        attachment_id,
        &bytes,
        &mime,
        &filename,
        cache_extracted,
    )
    .map_err(|e| e.to_string())
}
