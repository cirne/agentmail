//! Integration tests: attachment extract/list/read/cache (fixtures under repo `tests/attachments/fixtures/`).

use std::fs;
use std::io::BufWriter;
use std::path::PathBuf;

use rust_xlsxwriter::Workbook;
use tempfile::tempdir;
use zmail::{
    extract_and_cache, extract_attachment, list_attachments_for_message, open_memory,
    read_stored_file,
};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/attachments/fixtures")
        .join(name)
}

#[test]
fn extract_csv_passthrough() {
    let p = fixture("sample-data.csv");
    let bytes = fs::read(&p).unwrap();
    let orig = String::from_utf8(bytes.clone()).unwrap();
    let t = extract_attachment(&bytes, "text/csv", "sample-data.csv").unwrap();
    assert_eq!(t, orig);
    assert!(t.contains("Widget A"));
}

#[test]
fn extract_html_to_text() {
    let p = fixture("sample-page.html");
    let bytes = fs::read(&p).unwrap();
    let t = extract_attachment(&bytes, "text/html", "sample-page.html").unwrap();
    assert!(t.contains("Terms of Service"));
    assert!(!t.contains("<h1>"));
}

#[test]
fn extract_xlsx_produces_csv() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("t.xlsx");
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.write_string(0, 0, "Segment").unwrap();
    ws.write_string(0, 1, "Country").unwrap();
    ws.write_string(1, 0, "Government").unwrap();
    wb.save(&path).unwrap();
    let bytes = fs::read(&path).unwrap();
    let t = extract_attachment(
        &bytes,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "t.xlsx",
    )
    .unwrap();
    assert!(t.contains("Segment"));
    assert!(t.contains("Government"));
    assert!(!t.contains("[object Object]"));
}

#[test]
fn extract_pdf_non_null() {
    use printpdf::*;
    let (doc, page, layer) = PdfDocument::new("t", Mm(210.0), Mm(297.0), "L1");
    let font = doc.add_builtin_font(BuiltinFont::Helvetica).unwrap();
    {
        let layer = doc.get_page(page).get_layer(layer);
        layer.use_text("HelloPDF", 12.0, Mm(10.0), Mm(280.0), &font);
    }
    let mut buf = BufWriter::new(Vec::new());
    doc.save(&mut buf).unwrap();
    let bytes = buf.into_inner().unwrap();
    let t = extract_attachment(&bytes, "application/pdf", "x.pdf").expect("pdf text");
    assert!(t.contains("HelloPDF"));
}

#[test]
fn extract_docx_non_null() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("d.docx");
    let mut file = fs::File::create(&path).unwrap();
    docx_rs::Docx::new()
        .add_paragraph(
            docx_rs::Paragraph::new().add_run(docx_rs::Run::new().add_text("Lorem ipsum dolor")),
        )
        .build()
        .pack(&mut file)
        .unwrap();
    let bytes = fs::read(&path).unwrap();
    let t = extract_attachment(
        &bytes,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "d.docx",
    )
    .expect("docx");
    assert!(t.contains("Lorem ipsum"));
}

#[test]
fn extract_unknown_type_returns_none() {
    assert!(extract_attachment(b"xyz", "application/octet-stream", "m.bin").is_none());
    assert!(extract_attachment(b"xyz", "image/png", "p.png").is_none());
}

#[test]
fn extract_docx_by_filename_when_mime_wrong() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("d.docx");
    let mut file = std::fs::File::create(&path).unwrap();
    docx_rs::Docx::new()
        .add_paragraph(
            docx_rs::Paragraph::new().add_run(docx_rs::Run::new().add_text("By extension")),
        )
        .build()
        .pack(&mut file)
        .unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let t = extract_attachment(
        &bytes,
        "application/octet-stream",
        "d.docx",
    )
    .expect("docx via .docx");
    assert!(t.contains("By extension"));
}

#[test]
fn extract_xlsx_multi_sheet_has_headers() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("multi.xlsx");
    let mut wb = Workbook::new();
    let ws1 = wb.add_worksheet();
    ws1.write_string(0, 0, "A1").unwrap();
    let ws2 = wb.add_worksheet();
    ws2.write_string(0, 0, "B1").unwrap();
    wb.save(&path).unwrap();
    let bytes = fs::read(&path).unwrap();
    let t = extract_attachment(
        &bytes,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "multi.xlsx",
    )
    .unwrap();
    assert!(t.contains("## Sheet:"));
    assert!(t.contains("A1"));
    assert!(t.contains("B1"));
}

#[test]
fn extract_and_cache_stub_for_binary() {
    let dir = tempdir().unwrap();
    let conn = open_memory().unwrap();
    conn.execute(
        "INSERT INTO messages (message_id, thread_id, folder, uid, from_address, to_addresses, cc_addresses, subject, body_text, date, raw_path)
         VALUES ('ms', 'ms', 'f', 1, 'a@b', '[]', '[]', 's', 'b', 'd', 'p')",
        [],
    )
    .unwrap();
    let bin_path = dir.path().join("z.bin");
    fs::write(&bin_path, [0u8; 1024]).unwrap();
    conn.execute(
        "INSERT INTO attachments (message_id, filename, mime_type, size, stored_path) VALUES ('ms', 'z.bin', 'application/octet-stream', 1024, ?1)",
        [bin_path.to_string_lossy().as_ref()],
    )
    .unwrap();
    let id: i64 = conn
        .query_row(
            "SELECT id FROM attachments WHERE message_id = 'ms'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let bytes = read_stored_file(&bin_path.to_string_lossy(), dir.path()).unwrap();
    let t = extract_and_cache(&conn, id, &bytes, "application/octet-stream", "z.bin", true).unwrap();
    assert!(t.contains("[Binary attachment:"));
    assert!(t.contains("z.bin"));
}

#[test]
fn list_attachments_for_message_json() {
    let conn = open_memory().unwrap();
    conn.execute(
        "INSERT INTO messages (message_id, thread_id, folder, uid, from_address, to_addresses, cc_addresses, subject, body_text, date, raw_path)
         VALUES ('mid-a', 'mid-a', 'f', 1, 'a@b', '[]', '[]', 's', 'b', 'd', 'p')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO attachments (message_id, filename, mime_type, size, stored_path) VALUES ('mid-a', 'f.csv', 'text/csv', 3, 'x')",
        [],
    )
    .unwrap();
    let rows = list_attachments_for_message(&conn, "mid-a").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].index, 1);
    assert!(!rows[0].extracted);
}

#[test]
fn read_attachment_extracts_on_demand() {
    let dir = tempdir().unwrap();
    let csv_path = dir.path().join("a.csv");
    fs::write(&csv_path, b"a,b,c").unwrap();
    let conn = open_memory().unwrap();
    conn.execute(
        "INSERT INTO messages (message_id, thread_id, folder, uid, from_address, to_addresses, cc_addresses, subject, body_text, date, raw_path)
         VALUES ('m1', 'm1', 'f', 1, 'a@b', '[]', '[]', 's', 'b', 'd', 'p')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO attachments (message_id, filename, mime_type, size, stored_path) VALUES ('m1', 'a.csv', 'text/csv', 5, ?1)",
        [csv_path.to_string_lossy().as_ref()],
    )
    .unwrap();
    let id: i64 = conn
        .query_row(
            "SELECT id FROM attachments WHERE message_id = 'm1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let bytes = read_stored_file(&csv_path.to_string_lossy(), dir.path()).unwrap();
    let t = extract_and_cache(&conn, id, &bytes, "text/csv", "a.csv", false).unwrap();
    assert_eq!(t.trim(), "a,b,c");
}

#[test]
fn read_attachment_caches_in_db() {
    let dir = tempdir().unwrap();
    let csv_path = dir.path().join("b.csv");
    fs::write(&csv_path, b"x").unwrap();
    let conn = open_memory().unwrap();
    conn.execute(
        "INSERT INTO messages (message_id, thread_id, folder, uid, from_address, to_addresses, cc_addresses, subject, body_text, date, raw_path)
         VALUES ('m2', 'm2', 'f', 1, 'a@b', '[]', '[]', 's', 'b', 'd', 'p')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO attachments (message_id, filename, mime_type, size, stored_path) VALUES ('m2', 'b.csv', 'text/csv', 1, ?1)",
        [csv_path.to_string_lossy().as_ref()],
    )
    .unwrap();
    let id: i64 = conn
        .query_row(
            "SELECT id FROM attachments WHERE message_id = 'm2'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let bytes = read_stored_file(&csv_path.to_string_lossy(), dir.path()).unwrap();
    extract_and_cache(&conn, id, &bytes, "text/csv", "b.csv", true).unwrap();
    let cached: String = conn
        .query_row(
            "SELECT extracted_text FROM attachments WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(cached, "x");
}
