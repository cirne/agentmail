//! Integration tests: attachment extract/list/read/cache (fixtures under `node/tests/attachments/fixtures/`).

use std::fs;
use std::io::BufWriter;
use std::path::PathBuf;

use base64::Engine;
use printpdf::*;
use rust_xlsxwriter::Workbook;
use tempfile::tempdir;
use zmail::{
    extract_and_cache, extract_attachment, list_attachments_for_message, open_memory,
    parse_raw_message_with_options, persist_attachments_from_parsed, persist_message,
    read_attachment_bytes, read_attachment_text, read_stored_file, ParseMessageOptions,
};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("node/tests/attachments/fixtures")
        .join(name)
}

fn minimal_pdf_hellopdf_bytes() -> Vec<u8> {
    let (doc, page, layer) = PdfDocument::new("t", Mm(210.0), Mm(297.0), "L1");
    let font = doc.add_builtin_font(BuiltinFont::Helvetica).unwrap();
    {
        let layer = doc.get_page(page).get_layer(layer);
        layer.use_text("HelloPDF", 12.0, Mm(10.0), Mm(280.0), &font);
    }
    let mut buf = BufWriter::new(Vec::new());
    doc.save(&mut buf).unwrap();
    buf.into_inner().unwrap()
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
    let bytes = minimal_pdf_hellopdf_bytes();
    let t = extract_attachment(&bytes, "application/pdf", "x.pdf").expect("pdf text");
    assert!(t.contains("HelloPDF"));
}

#[test]
fn extract_pdf_by_filename_when_mime_wrong() {
    let bytes = minimal_pdf_hellopdf_bytes();
    let t =
        extract_attachment(&bytes, "application/octet-stream", "invoice.PDF").expect("pdf text");
    assert!(t.contains("HelloPDF"));
}

#[test]
fn extract_pdf_parameterized_mime_type() {
    let bytes = minimal_pdf_hellopdf_bytes();
    let t =
        extract_attachment(&bytes, "application/pdf; name=\"x.pdf\"", "y.dat").expect("pdf text");
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
    let t =
        extract_attachment(&bytes, "application/octet-stream", "d.docx").expect("docx via .docx");
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
    let t =
        extract_and_cache(&conn, id, &bytes, "application/octet-stream", "z.bin", true).unwrap();
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

/// Legacy drift: `attachments.message_id` bare while `messages.message_id` is bracketed (FK off simulates old DBs / manual fixes).
#[test]
fn list_attachments_matches_when_attachment_message_id_bare_messages_bracketed() {
    let conn = open_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
    conn.execute(
        "INSERT INTO messages (message_id, thread_id, folder, uid, from_address, to_addresses, cc_addresses, subject, body_text, date, raw_path)
         VALUES ('<match@x>', '<match@x>', 'f', 1, 'a@b', '[]', '[]', 's', 'b', 'd', 'p')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO attachments (message_id, filename, mime_type, size, stored_path) VALUES ('match@x', 'f.pdf', 'application/pdf', 3, '')",
        [],
    )
    .unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
    assert_eq!(
        list_attachments_for_message(&conn, "match@x")
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        list_attachments_for_message(&conn, "<match@x>")
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn read_attachment_bytes_finds_legacy_maildir_attachments_file() {
    let dir = tempdir().unwrap();
    let data_dir = dir.path();
    let mid = "<legacy@x>";
    let sub = data_dir.join("maildir").join("attachments").join(mid);
    fs::create_dir_all(&sub).unwrap();
    let pdf_path = sub.join("doc.pdf");
    fs::write(&pdf_path, b"%PDF-1.4 test").unwrap();

    let conn = open_memory().unwrap();
    conn.execute(
        "INSERT INTO messages (message_id, thread_id, folder, uid, from_address, to_addresses, cc_addresses, subject, body_text, date, raw_path)
         VALUES ('<legacy@x>', '<legacy@x>', 'f', 1, 'a@b', '[]', '[]', 's', 'b', 'd', 'p')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO attachments (message_id, filename, mime_type, size, stored_path) VALUES ('<legacy@x>', 'doc.pdf', 'application/pdf', 12, '')",
        [],
    )
    .unwrap();
    let id: i64 = conn
        .query_row(
            "SELECT id FROM attachments WHERE message_id = '<legacy@x>'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let bytes = read_attachment_bytes(&conn, data_dir, id).unwrap();
    assert_eq!(bytes, b"%PDF-1.4 test");
    let stored: String = conn
        .query_row(
            "SELECT stored_path FROM attachments WHERE id = ?1",
            [id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(stored.contains("maildir/attachments"));
    assert!(stored.ends_with("doc.pdf"));
}

/// BUG-036 / agent path: UTF-8 bytes in quoted `filename=` + PDF → index → `read_attachment_text` returns markdown with extractable body.
#[test]
fn utf8_pdf_filename_eml_read_attachment_text_markdown() {
    let mut buf = BufWriter::new(Vec::new());
    {
        let (doc, page, layer) = PdfDocument::new("t", Mm(210.0), Mm(297.0), "L1");
        let font = doc.add_builtin_font(BuiltinFont::Helvetica).unwrap();
        let layer = doc.get_page(page).get_layer(layer);
        layer.use_text(
            "BROCHURE_PARTNERSHIP_TEXT",
            12.0,
            Mm(10.0),
            Mm(280.0),
            &font,
        );
        doc.save(&mut buf).unwrap();
    }
    let pdf_bytes = buf.into_inner().unwrap();
    let b64 = base64::engine::general_purpose::STANDARD.encode(&pdf_bytes);

    let mut raw: Vec<u8> = concat!(
        "From: a@b.com\r\n",
        "Subject: utf8 pdf\r\n",
        "Date: Thu, 4 Jan 2024 10:00:00 +0000\r\n",
        "Message-ID: <utf8pdf@test>\r\n",
        "MIME-Version: 1.0\r\n",
        "Content-Type: multipart/mixed; boundary=\"b\"\r\n",
        "\r\n",
        "--b\r\n",
        "Content-Type: text/plain\r\n",
        "\r\n",
        "Hi\r\n",
        "--b\r\n",
        "Content-Disposition: attachment; filename=\"Bel",
    )
    .as_bytes()
    .to_vec();
    raw.extend_from_slice("óved Brochure.pdf".as_bytes());
    raw.extend_from_slice(
        concat!("\"\r\n", "Content-Type: application/pdf; name=\"Bel",).as_bytes(),
    );
    raw.extend_from_slice("óved Brochure.pdf".as_bytes());
    raw.extend_from_slice(
        concat!("\"\r\n", "Content-Transfer-Encoding: base64\r\n", "\r\n").as_bytes(),
    );
    raw.extend_from_slice(b64.as_bytes());
    raw.extend_from_slice(b"\r\n--b--\r\n");

    let p = parse_raw_message_with_options(
        &raw,
        ParseMessageOptions {
            include_attachments: true,
            include_attachment_bytes: true,
        },
    );
    assert_eq!(p.attachments.len(), 1, "{:?}", p.attachments);
    assert!(
        p.attachments[0].filename.contains("Brochure"),
        "filename={:?}",
        p.attachments[0].filename
    );

    let dir = tempdir().unwrap();
    let data_dir = dir.path();
    let maildir_rel = "maildir/cur/utf8.eml";
    let eml_path = data_dir.join(maildir_rel);
    fs::create_dir_all(eml_path.parent().unwrap()).unwrap();
    fs::write(&eml_path, &raw).unwrap();

    let conn = open_memory().unwrap();
    persist_message(&conn, &p, "INBOX", 1, "[]", maildir_rel).unwrap();
    persist_attachments_from_parsed(&conn, &p.message_id, &p.attachments, data_dir).unwrap();

    let id: i64 = conn
        .query_row(
            "SELECT id FROM attachments WHERE message_id = ?1",
            [&p.message_id],
            |r| r.get(0),
        )
        .unwrap();

    let out = read_attachment_text(&conn, data_dir, id, false, false).unwrap();
    assert!(
        out.starts_with("## ") && out.contains("Brochure"),
        "expected markdown heading with filename, got: {out:?}"
    );
    assert!(
        out.contains("BROCHURE_PARTNERSHIP_TEXT"),
        "expected PDF text in body, got: {out:?}"
    );
}
