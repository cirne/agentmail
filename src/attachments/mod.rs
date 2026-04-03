//! On-demand attachment text extraction (TS `~/attachments` subset).

use calamine::{Data, Reader};
use rusqlite::{Connection, ToSql};
use std::io::Cursor;
use std::panic;
use std::path::{Path, PathBuf};

use crate::mail_read::resolve_raw_path;
use crate::sync::parse_message::{parse_raw_message_with_options, ParseMessageOptions};

/// CLI/MCP: present PDF text as markdown (`## filename` + body) for agent readability (matches MCP tool copy).
fn format_pdf_attachment_markdown(filename: &str, body: &str) -> String {
    format!("## {}\n\n{}", filename, body.trim())
}

fn mime_is_application_pdf(mime: &str) -> bool {
    mime.split(';')
        .next()
        .map(|s| s.trim().eq_ignore_ascii_case("application/pdf"))
        .unwrap_or(false)
}

/// PDF extract + markdown wrapping: correct MIME, or `.pdf` filename (common `application/octet-stream`).
fn attachment_is_pdf(mime: &str, filename: &str) -> bool {
    mime_is_application_pdf(mime) || filename.to_lowercase().ends_with(".pdf")
}

/// PDF text via `pdf_oxide` (tolerates many real-world PDFs vs older pure-Rust extractors).
/// `extract_all_text` uses form-feed page breaks; normalize for readability.
/// Panics are caught so CLI/MCP return the binary stub instead of aborting.
fn extract_pdf_text_pdf_oxide(bytes: &[u8]) -> Option<String> {
    let mut doc = pdf_oxide::PdfDocument::from_bytes(bytes.to_vec()).ok()?;
    let raw = doc.extract_all_text().ok()?;
    let t = raw.replace('\u{000C}', "\n\n").trim().to_string();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

fn extract_pdf_text(bytes: &[u8]) -> Option<String> {
    let owned = bytes.to_vec();
    panic::catch_unwind(move || extract_pdf_text_pdf_oxide(&owned))
        .ok()
        .flatten()
}

/// Best-effort text/markdown extraction by MIME type and filename (order aligned with Node; PDF also matches `.pdf` for wrong Content-Type).
pub fn extract_attachment(bytes: &[u8], mime: &str, filename: &str) -> Option<String> {
    let m = mime.to_lowercase();
    let name = filename.to_lowercase();

    // PDF — MIME or `.pdf` name (CLI: tolerate wrong Content-Type on real mail)
    if attachment_is_pdf(mime, filename) {
        return extract_pdf_text(bytes);
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
    let keys = crate::ids::attachment_message_id_lookup_keys(&mid);
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = keys.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT id, filename, mime_type, size, extracted_text, stored_path FROM attachments WHERE message_id IN ({placeholders}) ORDER BY id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<&dyn ToSql> = keys.iter().map(|s| s as &dyn ToSql).collect();
    let rows = stmt.query_map(params.as_slice(), |row| {
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
pub fn read_stored_file(stored_path: &str, data_dir: &Path) -> std::io::Result<Vec<u8>> {
    let sp = stored_path.trim();
    if sp.is_empty() || sp == "." {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "empty or invalid stored_path",
        ));
    }
    let p = if Path::new(sp).is_absolute() {
        PathBuf::from(sp)
    } else {
        data_dir.join(sp)
    };
    std::fs::read(p)
}

fn stored_path_is_usable(stored_path: &str) -> bool {
    let sp = stored_path.trim();
    !sp.is_empty() && sp != "."
}

/// `maildir/attachments/<message-id-folder>/<filename>` (folder name may be bare or bracketed).
fn try_legacy_attachment_bytes(
    conn: &Connection,
    data_dir: &Path,
    attachment_id: i64,
    message_id: &str,
    filename: &str,
) -> Result<Option<Vec<u8>>, String> {
    let Some(canonical) =
        crate::ids::resolve_message_id(conn, message_id).map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    let keys = crate::ids::attachment_message_id_lookup_keys(&canonical);
    let base = data_dir.join("maildir").join("attachments");
    for folder in keys {
        let p = base.join(&folder).join(filename);
        if p.is_file() {
            let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
            let rel = p
                .strip_prefix(data_dir)
                .unwrap_or(p.as_path())
                .to_string_lossy()
                .to_string();
            let _ = conn.execute(
                "UPDATE attachments SET stored_path = ?1 WHERE id = ?2 AND (stored_path IS NULL OR trim(stored_path) = '')",
                rusqlite::params![&rel, attachment_id],
            );
            return Ok(Some(bytes));
        }
    }
    Ok(None)
}

fn ordinal_attachment_1based(
    conn: &Connection,
    message_id_keys: &[String],
    attachment_id: i64,
) -> Result<i64, String> {
    if message_id_keys.is_empty() {
        return Err("attachment message id keys empty".into());
    }
    let placeholders = message_id_keys
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT COUNT(*) FROM attachments a2 WHERE a2.message_id IN ({placeholders}) AND a2.id <= ?"
    );
    let mut vals: Vec<&dyn ToSql> = message_id_keys.iter().map(|s| s as &dyn ToSql).collect();
    vals.push(&attachment_id);
    conn.query_row(&sql, vals.as_slice(), |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())
}

/// Load raw bytes for an attachment: legacy `stored_path` file, or extract from the message `.eml`
/// when `stored_path` is empty (metadata-only index).
pub fn read_attachment_bytes(
    conn: &Connection,
    data_dir: &Path,
    attachment_id: i64,
) -> Result<Vec<u8>, String> {
    let row: (String, String, String) = conn
        .query_row(
            "SELECT stored_path, message_id, filename FROM attachments WHERE id = ?1",
            [attachment_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|e| e.to_string())?;
    let (stored_path, message_id, filename) = row;
    if stored_path_is_usable(&stored_path) {
        if let Ok(bytes) = read_stored_file(stored_path.trim(), data_dir) {
            return Ok(bytes);
        }
    }
    if let Some(bytes) =
        try_legacy_attachment_bytes(conn, data_dir, attachment_id, &message_id, &filename)?
    {
        return Ok(bytes);
    }
    attachment_bytes_from_raw_mail(conn, data_dir, attachment_id)
}

fn attachment_bytes_from_raw_mail(
    conn: &Connection,
    data_dir: &Path,
    attachment_id: i64,
) -> Result<Vec<u8>, String> {
    let att_mid: String = conn
        .query_row(
            "SELECT message_id FROM attachments WHERE id = ?1",
            [attachment_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let Some((canonical_mid, raw_path)) =
        crate::ids::resolve_message_id_and_raw_path(conn, &att_mid).map_err(|e| e.to_string())?
    else {
        return Err(format!(
            "no message in index for attachment id {attachment_id}"
        ));
    };
    let keys = crate::ids::attachment_message_id_lookup_keys(&canonical_mid);
    let ord_1based = ordinal_attachment_1based(conn, &keys, attachment_id)?;
    let path = resolve_raw_path(&raw_path, data_dir);
    let raw = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let parsed = parse_raw_message_with_options(
        &raw,
        ParseMessageOptions {
            include_attachments: true,
            include_attachment_bytes: true,
        },
    );
    let idx = (ord_1based as usize).saturating_sub(1);
    parsed
        .attachments
        .get(idx)
        .map(|a| a.content.clone())
        .ok_or_else(|| {
            format!(
                "attachment ordinal {} not in parsed message (have {} attachment(s))",
                ord_1based,
                parsed.attachments.len()
            )
        })
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

    let (filename, mime, extracted_text): (String, String, Option<String>) = conn
        .query_row(
            "SELECT filename, mime_type, extracted_text FROM attachments WHERE id = ?1",
            [attachment_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|e| e.to_string())?;

    let use_cached =
        cache_extracted && !no_cache && extracted_text.as_ref().is_some_and(|s| !s.is_empty());
    let text = if use_cached {
        extracted_text.unwrap()
    } else {
        let bytes = read_attachment_bytes(conn, data_dir, attachment_id)?;
        extract_and_cache(
            conn,
            attachment_id,
            &bytes,
            &mime,
            &filename,
            cache_extracted,
        )
        .map_err(|e| e.to_string())?
    };

    if attachment_is_pdf(&mime, &filename) {
        Ok(format_pdf_attachment_markdown(&filename, &text))
    } else {
        Ok(text)
    }
}
