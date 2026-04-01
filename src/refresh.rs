//! `zmail refresh` JSON/text output (mirrors `src/cli/refresh-output.ts`).

use rusqlite::Connection;

use crate::mail_category::is_default_excluded_category;
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(
        rename = "matchedRuleIds",
        skip_serializing_if = "Vec::is_empty",
        default
    )]
    pub matched_rule_ids: Vec<String>,
    #[serde(rename = "decisionSource", skip_serializing_if = "Option::is_none")]
    pub decision_source: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize, PartialEq, Eq)]
pub struct InboxDispositionCounts {
    pub notify: usize,
    pub inform: usize,
    pub archive: usize,
    pub suppress: usize,
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

/// Load up to 10 new-mail preview rows (default category filter unless `include_all`).
pub fn load_refresh_new_mail(
    conn: &Connection,
    new_message_ids: &[String],
    include_all: bool,
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
         category
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
                row.get::<_, Option<String>>(6)?,
            ))
        })?
        .filter_map(|r| r.ok())
        .filter(|(_, _, _, _, _, _, category)| {
            include_all || !is_default_excluded_category(category.as_deref())
        })
        .map(
            |(mid, from_a, from_n, subj, date, snippet, _category)| RefreshPreviewRow {
                message_id: mid,
                from_address: from_a,
                from_name: from_n,
                subject: subj,
                date,
                snippet: strip_html_tags(&snippet),
                note: None,
                attachments: None,
                category: None,
                action: None,
                matched_rule_ids: vec![],
                decision_source: None,
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

pub fn build_check_json(
    sync: &SyncResult,
    surfaced: &[RefreshPreviewRow],
    processed: Option<&[RefreshPreviewRow]>,
    counts: &InboxDispositionCounts,
    candidates_scanned: usize,
    llm_duration_ms: u64,
    omit_refresh_metrics: bool,
) -> serde_json::Value {
    if omit_refresh_metrics {
        let mut value = serde_json::json!({
            "notifications": surfaced,
            "counts": counts,
            "candidatesScanned": candidates_scanned,
            "llmDurationMs": llm_duration_ms,
        });
        if let Some(processed) = processed {
            value["processed"] = serde_json::json!(processed);
        }
        return value;
    }
    let mut value = build_refresh_json_value_with_extras(
        sync,
        surfaced,
        Some(serde_json::json!({
            "counts": counts,
            "candidatesScanned": candidates_scanned,
            "llmDurationMs": llm_duration_ms,
        })),
    );
    if let Some(processed) = processed {
        value["processed"] = serde_json::json!(processed);
    }
    value
}

pub fn build_review_json(
    surfaced: &[RefreshPreviewRow],
    processed: Option<&[RefreshPreviewRow]>,
    counts: &InboxDispositionCounts,
    candidates_scanned: usize,
    llm_duration_ms: u64,
) -> serde_json::Value {
    let mut value = serde_json::json!({
        "items": surfaced,
        "counts": counts,
        "candidatesScanned": candidates_scanned,
        "llmDurationMs": llm_duration_ms,
    });
    if let Some(processed) = processed {
        value["processed"] = serde_json::json!(processed);
    }
    value
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
    debug_assert!(width > 0, "wrap_line width must be positive");
    if line.len() <= width {
        return vec![line.to_string()];
    }
    let mut out = Vec::new();
    let mut rest = line;
    while rest.len() > width {
        let chunk_end = rest.floor_char_boundary(width);
        let mut break_at = rest[..chunk_end].rfind(' ').unwrap_or(chunk_end);
        if break_at <= width / 2 {
            break_at = chunk_end;
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

fn print_counts(counts: &InboxDispositionCounts) {
    println!("  notify:   {}", counts.notify);
    println!("  inform:   {}", counts.inform);
    println!("  archive:  {}", counts.archive);
    println!("  suppress: {}", counts.suppress);
}

pub fn print_check_text(
    sync: &SyncResult,
    surfaced: &[RefreshPreviewRow],
    processed: Option<&[RefreshPreviewRow]>,
    counts: &InboxDispositionCounts,
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
    if omit_refresh_metrics && surfaced.is_empty() {
        println!("No urgent messages right now.");
    }
    println!();
    println!("Summary:");
    print_counts(counts);
    if !surfaced.is_empty() {
        println!();
        println!("{preview_title}");
        for m in surfaced {
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
            if let Some(ref action) = m.action {
                println!("Action:  {action}");
            }
            if let Some(ref category) = m.category {
                println!("Category:{category}");
            }
            if !m.matched_rule_ids.is_empty() {
                println!("Rules:   {}", m.matched_rule_ids.join(", "));
            }
            print_indented_block("Preview:", &m.snippet);
        }
        println!();
        println!("{MESSAGE_SEPARATOR}");
    }
    if let Some(processed) = processed {
        if !processed.is_empty() {
            println!();
            println!("Processed:");
            for row in processed {
                let action = row.action.as_deref().unwrap_or("notify");
                let category = row.category.as_deref().unwrap_or("uncategorized");
                println!("  {action:>8}  {category:<12}  {}", row.message_id);
                if let Some(note) = &row.note {
                    println!("    {note}");
                }
            }
        }
    }
}

pub fn print_review_text(
    surfaced: &[RefreshPreviewRow],
    processed: Option<&[RefreshPreviewRow]>,
    counts: &InboxDispositionCounts,
) {
    if surfaced.is_empty() {
        println!("No inbox items to review in this window.");
    } else {
        println!("Inbox review:");
        for m in surfaced {
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
            if let Some(ref action) = m.action {
                println!("Action:  {action}");
            }
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
            if !m.matched_rule_ids.is_empty() {
                println!("Rules:   {}", m.matched_rule_ids.join(", "));
            }
            print_indented_block("Preview:", &m.snippet);
        }
        println!();
        println!("{MESSAGE_SEPARATOR}");
    }
    println!();
    println!("Summary:");
    print_counts(counts);
    if let Some(processed) = processed {
        if !processed.is_empty() {
            println!();
            println!("Processed:");
            for row in processed {
                let action = row.action.as_deref().unwrap_or("inform");
                let category = row.category.as_deref().unwrap_or("uncategorized");
                println!("  {action:>8}  {category:<12}  {}", row.message_id);
                if let Some(note) = &row.note {
                    println!("    {note}");
                }
            }
        }
    }
}

#[cfg(test)]
mod wrap_line_tests {
    use super::wrap_line;

    /// Regression: fixed-byte slice at `width` must not split a multi-byte char (e.g. U+2026 …).
    #[test]
    fn wrap_line_does_not_panic_on_ellipsis_at_byte_boundary() {
        let line = format!("{}…", "x".repeat(98));
        assert!(line.len() > 100);
        let lines = wrap_line(&line, 100);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "x".repeat(98));
        assert_eq!(lines[1], "…");
    }

    #[test]
    fn wrap_line_prefers_space_break_inside_chunk() {
        let line = format!("{} word {}", "a".repeat(80), "b".repeat(40));
        let lines = wrap_line(&line, 100);
        assert!(
            lines.iter().all(|l| l.len() <= 100),
            "each line should be at most 100 bytes: {lines:?}"
        );
        assert!(lines.len() >= 2);
        assert!(lines[0].contains("word"));
    }

    #[test]
    fn wrap_line_short_line_unchanged() {
        assert_eq!(wrap_line("hello", 100), vec!["hello".to_string()]);
    }
}
