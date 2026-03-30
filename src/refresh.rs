//! `zmail refresh` JSON/text output (mirrors `src/cli/refresh-output.ts`).

use rusqlite::Connection;

use crate::search::sort_rows_by_sender_contact_rank;
use crate::sync::SyncResult;

#[derive(Debug, Clone, serde::Serialize)]
pub struct RefreshPreviewAttachment {
    pub id: i64,
    pub filename: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub index: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RefreshPreviewRow {
    #[serde(rename = "messageId")]
    pub message_id: String,
    pub date: String,
    #[serde(rename = "fromAddress")]
    pub from_address: String,
    #[serde(rename = "fromName")]
    pub from_name: Option<String>,
    pub subject: String,
    pub snippet: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<RefreshPreviewAttachment>>,
}

fn strip_html_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Load up to 10 new-mail preview rows (noise filtered unless `include_noise`).
pub fn load_refresh_new_mail(
    conn: &Connection,
    new_message_ids: &[String],
    include_noise: bool,
    owner_address: Option<&str>,
) -> rusqlite::Result<Vec<RefreshPreviewRow>> {
    if new_message_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = new_message_ids
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT message_id, from_address, from_name, subject, date,
         COALESCE(TRIM(SUBSTR(body_text, 1, 200)), '') ||
         CASE WHEN LENGTH(TRIM(body_text)) > 200 THEN '…' ELSE '' END AS snippet,
         is_noise
         FROM messages WHERE message_id IN ({placeholders}) ORDER BY date DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows: Vec<RefreshPreviewRow> = stmt
        .query_map(rusqlite::params_from_iter(new_message_ids.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .filter(|(_, _, _, _, _, _, noise)| include_noise || *noise == 0)
        .map(
            |(mid, from_a, from_n, subj, date, snippet, _)| RefreshPreviewRow {
                message_id: mid,
                from_address: from_a,
                from_name: from_n,
                subject: subj,
                date,
                snippet: strip_html_tags(&snippet),
                note: None,
                attachments: None,
            },
        )
        .collect();

    rows = sort_rows_by_sender_contact_rank(
        conn,
        owner_address,
        rows,
        |r| &r.from_address,
        |r| &r.date,
    )?;

    rows.truncate(10);

    for r in &mut rows {
        let atts = load_attachments_indexed(conn, &r.message_id)?;
        if !atts.is_empty() {
            r.attachments = Some(atts);
        }
    }

    Ok(rows)
}

fn load_attachments_indexed(
    conn: &Connection,
    message_id: &str,
) -> rusqlite::Result<Vec<RefreshPreviewAttachment>> {
    let rows = crate::attachments::list_attachments_for_message(conn, message_id)?;
    Ok(rows
        .into_iter()
        .map(|a| RefreshPreviewAttachment {
            id: a.id,
            filename: a.filename,
            mime_type: a.mime_type,
            index: a.index,
        })
        .collect())
}

/// JSON object matching Node `buildRefreshStylePayload`.
pub fn build_refresh_json_value(
    sync: &SyncResult,
    new_mail: &[RefreshPreviewRow],
) -> serde_json::Value {
    build_refresh_json_value_with_extras(sync, new_mail, None)
}

/// Full refresh-style JSON plus optional extras (`candidatesScanned`, `llmDurationMs` for inbox).
pub fn build_refresh_json_value_with_extras(
    sync: &SyncResult,
    new_mail: &[RefreshPreviewRow],
    extras: Option<serde_json::Value>,
) -> serde_json::Value {
    let mut v = serde_json::json!({
        "synced": sync.synced,
        "messagesFetched": sync.messages_fetched,
        "bytesDownloaded": sync.bytes_downloaded,
        "durationMs": sync.duration_ms,
        "bandwidthBytesPerSec": sync.bandwidth_bytes_per_sec,
        "messagesPerMinute": sync.messages_per_minute,
        "newMail": new_mail,
    });
    if let Some(true) = sync.early_exit {
        v["earlyExit"] = serde_json::json!(true);
    }
    if let Some(serde_json::Value::Object(m)) = extras {
        for (k, val) in m {
            v[k] = val;
        }
    }
    v
}

/// Inbox / refresh-style JSON: full sync metrics, or scan-only (`newMail` + extras) when `omit_refresh_metrics`.
pub fn build_inbox_style_json(
    sync: &SyncResult,
    new_mail: &[RefreshPreviewRow],
    candidates_scanned: usize,
    llm_duration_ms: u64,
    omit_refresh_metrics: bool,
) -> serde_json::Value {
    if omit_refresh_metrics {
        return serde_json::json!({
            "newMail": new_mail,
            "candidatesScanned": candidates_scanned,
            "llmDurationMs": llm_duration_ms,
        });
    }
    build_refresh_json_value_with_extras(
        sync,
        new_mail,
        Some(serde_json::json!({
            "candidatesScanned": candidates_scanned,
            "llmDurationMs": llm_duration_ms,
        })),
    )
}

pub fn print_refresh_text(sync: &SyncResult, new_mail: &[RefreshPreviewRow]) {
    let sec = (sync.duration_ms as f64) / 1000.0;
    let mb = (sync.bytes_downloaded as f64) / (1024.0 * 1024.0);
    let kbps = (sync.bandwidth_bytes_per_sec) / 1024.0;
    println!();
    if sync.early_exit == Some(true) {
        println!("No new messages (skipped fetch).");
    }
    println!("Refresh metrics:");
    println!(
        "  messages:  {} new, {} fetched",
        sync.synced, sync.messages_fetched
    );
    println!(
        "  downloaded: {:.2} MB ({} bytes)",
        mb, sync.bytes_downloaded
    );
    println!("  bandwidth: {:.1} KB/s", kbps);
    println!(
        "  throughput: {} msg/min",
        sync.messages_per_minute.round() as i64
    );
    println!("  duration:  {sec:.2}s");
    println!("Sync log: {}", sync.log_path);
    if !new_mail.is_empty() {
        println!();
        println!("New mail:");
        const SEP: &str =
            "────────────────────────────────────────────────────────────────────────";
        for m in new_mail {
            println!("{SEP}");
            println!("{}  {}", &m.date[..m.date.len().min(10)], m.from_address);
            println!("{}", m.subject);
            if !m.snippet.is_empty() {
                println!("  {}", m.snippet);
            }
        }
        println!("{SEP}");
    }
}

const MESSAGE_SEPARATOR: &str =
    "────────────────────────────────────────────────────────────────────────";
const TEXT_WRAP_WIDTH: usize = 100;

fn wrap_line(line: &str, width: usize) -> Vec<String> {
    if line.len() <= width {
        return vec![line.to_string()];
    }
    let mut out = Vec::new();
    let mut rest = line;
    while rest.len() > width {
        let mut break_at = rest[..width].rfind(' ').unwrap_or(width);
        if break_at <= width / 2 {
            break_at = width;
        }
        out.push(rest[..break_at].trim_end().to_string());
        rest = rest[break_at..].trim_start();
    }
    if !rest.is_empty() {
        out.push(rest.to_string());
    }
    out
}

fn print_indented_block(title: &str, body: &str) {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return;
    }
    println!("{title}");
    for para in trimmed.split('\n') {
        for wrapped in wrap_line(para, TEXT_WRAP_WIDTH) {
            println!("  {wrapped}");
        }
    }
}

/// Text output for `zmail inbox` / refresh-style (`src/cli/refresh-output.ts` `printRefreshStyleOutput`).
pub fn print_inbox_style_text(
    sync: &SyncResult,
    new_mail: &[RefreshPreviewRow],
    preview_title: &str,
    omit_refresh_metrics: bool,
) {
    println!();
    if !omit_refresh_metrics {
        if sync.early_exit == Some(true) {
            println!("No new messages (skipped fetch).");
        }
        println!("Refresh metrics:");
        println!(
            "  messages:  {} new, {} fetched",
            sync.synced, sync.messages_fetched
        );
        let mb = (sync.bytes_downloaded as f64) / (1024.0 * 1024.0);
        let kbps = sync.bandwidth_bytes_per_sec / 1024.0;
        let sec = (sync.duration_ms as f64) / 1000.0;
        println!(
            "  downloaded: {:.2} MB ({} bytes)",
            mb, sync.bytes_downloaded
        );
        println!("  bandwidth: {:.1} KB/s", kbps);
        println!(
            "  throughput: {} msg/min",
            sync.messages_per_minute.round() as i64
        );
        println!("  duration:  {sec:.2}s");
    }
    if omit_refresh_metrics && new_mail.is_empty() {
        println!("No notable messages in this window.");
    }
    if !new_mail.is_empty() {
        println!();
        println!("{preview_title}");
        for m in new_mail {
            println!();
            println!("{MESSAGE_SEPARATOR}");
            let from_line = match &m.from_name {
                Some(n) if !n.is_empty() => format!("{n} <{}>", m.from_address),
                _ => format!("<{}>", m.from_address),
            };
            println!("Date:    {}", m.date);
            println!("From:    {from_line}");
            println!("Subject: {}", m.subject);
            println!("Id:      {}", m.message_id);
            if let Some(ref atts) = m.attachments {
                if !atts.is_empty() {
                    println!("Attachments:");
                    for a in atts {
                        println!("  {}. {} ({})", a.index, a.filename, a.mime_type);
                    }
                }
            }
            if let Some(ref note) = m.note {
                let one: String = note.split_whitespace().collect::<Vec<_>>().join(" ");
                println!("Note:    {one}");
            }
            print_indented_block("Preview:", &m.snippet);
        }
        println!();
        println!("{MESSAGE_SEPARATOR}");
    }
}
