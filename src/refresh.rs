//! `zmail refresh` JSON/text output (mirrors `src/cli/refresh-output.ts`).

use std::collections::HashMap;

use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::inbox::InboxSurfaceMode;
use crate::mail_category::is_default_excluded_category;
use crate::search::sort_rows_by_sender_contact_rank;
use crate::sync::SyncResult;

/// Minimum surfaced count before suggesting rules / window narrowing due to volume.
const INBOX_HINTS_LARGE_SURFACED: usize = 16;

#[derive(Debug, Clone, serde::Serialize)]
pub struct RefreshPreviewAttachment {
    pub id: i64,
    pub filename: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub index: i64,
}

/// Subset of [`RefreshPreviewRow`] for default `check`/`review` JSON (no `--thorough` / `--diagnostics` / etc.).
#[derive(Debug, Clone, Serialize)]
struct InboxPreviewRowSlim {
    #[serde(
        rename = "messageId",
        serialize_with = "crate::ids::serialize_string_id_for_json"
    )]
    message_id: String,
    date: String,
    #[serde(rename = "fromAddress")]
    from_address: String,
    #[serde(rename = "fromName", skip_serializing_if = "Option::is_none")]
    from_name: Option<String>,
    subject: String,
    snippet: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    #[serde(
        rename = "requiresUserAction",
        skip_serializing_if = "std::ops::Not::not"
    )]
    requires_user_action: bool,
    #[serde(rename = "actionSummary", skip_serializing_if = "Option::is_none")]
    action_summary: Option<String>,
}

impl From<&RefreshPreviewRow> for InboxPreviewRowSlim {
    fn from(r: &RefreshPreviewRow) -> Self {
        Self {
            message_id: r.message_id.clone(),
            date: r.date.clone(),
            from_address: r.from_address.clone(),
            from_name: r.from_name.clone(),
            subject: r.subject.clone(),
            snippet: r.snippet.clone(),
            action: r.action.clone(),
            category: r.category.clone(),
            requires_user_action: r.requires_user_action,
            action_summary: r.action_summary.clone(),
        }
    }
}

fn preview_rows_json_value(rows: &[RefreshPreviewRow], full_detail: bool) -> Value {
    if full_detail {
        serde_json::to_value(rows).unwrap_or_else(|_| json!([]))
    } else {
        let slim: Vec<InboxPreviewRowSlim> = rows.iter().map(InboxPreviewRowSlim::from).collect();
        serde_json::to_value(&slim).unwrap_or_else(|_| json!([]))
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct RefreshPreviewRow {
    #[serde(
        rename = "messageId",
        serialize_with = "crate::ids::serialize_string_id_for_json"
    )]
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
    #[serde(
        rename = "requiresUserAction",
        default,
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub requires_user_action: bool,
    #[serde(rename = "actionSummary", skip_serializing_if = "Option::is_none")]
    pub action_summary: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize, PartialEq, Eq)]
pub struct InboxDispositionCounts {
    pub notify: usize,
    pub inform: usize,
    pub ignore: usize,
    #[serde(rename = "actionRequired")]
    pub action_required: usize,
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
                requires_user_action: false,
                action_summary: None,
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

/// Short, actionable strings for agents when `zmail inbox` JSON is large or skewed.
/// Omit the `hints` field in JSON when this returns empty.
pub fn inbox_json_hints(
    mode: InboxSurfaceMode,
    surfaced: &[RefreshPreviewRow],
    counts: &InboxDispositionCounts,
    candidates_scanned: usize,
    diagnostics: bool,
) -> Vec<String> {
    let mut hints = Vec::new();
    if surfaced.is_empty() {
        if counts.action_required > 0 {
            hints.push(format!(
                "{} message(s) need your action — run `zmail inbox --diagnostics` for full rows (requiresUserAction / actionSummary). Archive when done.",
                counts.action_required
            ));
        }
        return hints;
    }

    if surfaced.len() >= INBOX_HINTS_LARGE_SURFACED {
        hints.push(
            "Large surfaced set: use `zmail rules` to add durable notify/inform/ignore rules, or narrow the time window."
                .to_string(),
        );
    }

    if surfaced.len() > 5 {
        let mut sender_counts: HashMap<&str, usize> = HashMap::new();
        for r in surfaced {
            *sender_counts.entry(r.from_address.as_str()).or_insert(0) += 1;
        }
        let max_sender = sender_counts.values().copied().max().unwrap_or(0);
        if max_sender as f64 / surfaced.len() as f64 > 0.8 {
            let top_sender = sender_counts
                .into_iter()
                .max_by_key(|(_, c)| *c)
                .map(|(a, _)| a)
                .unwrap_or("");
            hints.push(format!(
                "Most surfaced mail is from {top_sender}. Add a sender- or domain-scoped rule or context with `zmail rules`."
            ));
        }
    }

    let n = surfaced.len();
    if candidates_scanned >= n.saturating_mul(5).max(20) && candidates_scanned > n {
        hints.push(format!(
            "Scanned {candidates_scanned} candidates but only surfaced {n}. Filters, categories, or rules may be excluding expected mail; use `zmail rules` to adjust rules or use --thorough."
        ));
    }

    let total_dispositions = counts.notify + counts.inform + counts.ignore;
    if total_dispositions >= 5 && counts.ignore * 100 / total_dispositions >= 70 {
        hints.push(
            "Most items are ignore: if that matches intent, add explicit ignore rules with `zmail rules` so future runs stay stable."
                .to_string(),
        );
    }

    if !diagnostics {
        hints.push(
            "Re-run with --diagnostics to see per-message decision source and matched rule ids."
                .to_string(),
        );
    }

    match mode {
        InboxSurfaceMode::Review => {
            hints.push("Archive handled items with `zmail archive <messageId>…`".to_string())
        }
        InboxSurfaceMode::Check => {
            hints.push("For non-urgent follow-up across the window, run `zmail inbox`.".to_string())
        }
    }

    if counts.action_required > 0 {
        hints.push(format!(
            "{} message(s) need your action (see requiresUserAction / actionSummary in JSON); archive when done.",
            counts.action_required
        ));
    }

    hints
}

/// JSON for urgent-style inbox output with sync metrics (internal / tests); key order is stable and `hints` is last when present.
#[allow(clippy::too_many_arguments)]
fn build_check_json_with_sync_ordered(
    sync: &SyncResult,
    surfaced: &[RefreshPreviewRow],
    processed: Option<&[RefreshPreviewRow]>,
    counts: &InboxDispositionCounts,
    candidates_scanned: usize,
    llm_duration_ms: u64,
    hints: &[String],
    full_detail: bool,
) -> Value {
    let mut map = Map::new();
    map.insert("synced".into(), json!(sync.synced));
    map.insert("messagesFetched".into(), json!(sync.messages_fetched));
    map.insert("bytesDownloaded".into(), json!(sync.bytes_downloaded));
    map.insert("durationMs".into(), json!(sync.duration_ms));
    map.insert(
        "bandwidthBytesPerSec".into(),
        json!(sync.bandwidth_bytes_per_sec),
    );
    map.insert("messagesPerMinute".into(), json!(sync.messages_per_minute));
    map.insert(
        "newMail".into(),
        preview_rows_json_value(surfaced, full_detail),
    );
    if sync.early_exit == Some(true) {
        map.insert("earlyExit".into(), json!(true));
    }
    map.insert(
        "counts".into(),
        serde_json::to_value(counts).unwrap_or(json!({})),
    );
    map.insert("candidatesScanned".into(), json!(candidates_scanned));
    map.insert("llmDurationMs".into(), json!(llm_duration_ms));
    if let Some(processed) = processed {
        map.insert(
            "processed".into(),
            preview_rows_json_value(processed, full_detail),
        );
    }
    if !hints.is_empty() {
        map.insert("hints".into(), json!(hints));
    }
    Value::Object(map)
}

#[allow(clippy::too_many_arguments)]
pub fn build_check_json(
    sync: &SyncResult,
    surfaced: &[RefreshPreviewRow],
    processed: Option<&[RefreshPreviewRow]>,
    counts: &InboxDispositionCounts,
    candidates_scanned: usize,
    llm_duration_ms: u64,
    omit_refresh_metrics: bool,
    hints: &[String],
    full_detail: bool,
) -> serde_json::Value {
    if omit_refresh_metrics {
        let mut map = Map::new();
        map.insert(
            "notifications".into(),
            preview_rows_json_value(surfaced, full_detail),
        );
        map.insert(
            "counts".into(),
            serde_json::to_value(counts).unwrap_or(json!({})),
        );
        map.insert("candidatesScanned".into(), json!(candidates_scanned));
        map.insert("llmDurationMs".into(), json!(llm_duration_ms));
        if let Some(processed) = processed {
            map.insert(
                "processed".into(),
                preview_rows_json_value(processed, full_detail),
            );
        }
        if !hints.is_empty() {
            map.insert("hints".into(), json!(hints));
        }
        return Value::Object(map);
    }
    build_check_json_with_sync_ordered(
        sync,
        surfaced,
        processed,
        counts,
        candidates_scanned,
        llm_duration_ms,
        hints,
        full_detail,
    )
}

pub fn build_review_json(
    surfaced: &[RefreshPreviewRow],
    processed: Option<&[RefreshPreviewRow]>,
    counts: &InboxDispositionCounts,
    candidates_scanned: usize,
    llm_duration_ms: u64,
    hints: &[String],
    full_detail: bool,
) -> serde_json::Value {
    let mut map = Map::new();
    map.insert(
        "items".into(),
        preview_rows_json_value(surfaced, full_detail),
    );
    map.insert(
        "counts".into(),
        serde_json::to_value(counts).unwrap_or(json!({})),
    );
    map.insert("candidatesScanned".into(), json!(candidates_scanned));
    map.insert("llmDurationMs".into(), json!(llm_duration_ms));
    if let Some(processed) = processed {
        map.insert(
            "processed".into(),
            preview_rows_json_value(processed, full_detail),
        );
    }
    if !hints.is_empty() {
        map.insert("hints".into(), json!(hints));
    }
    Value::Object(map)
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
    println!("  ignore:   {}", counts.ignore);
    println!("  action:   {}", counts.action_required);
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
            if m.requires_user_action {
                match &m.action_summary {
                    Some(s) if !s.trim().is_empty() => {
                        println!("Action required: {s}");
                    }
                    _ => println!("Action required: yes"),
                }
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
            if m.requires_user_action {
                match &m.action_summary {
                    Some(s) if !s.trim().is_empty() => {
                        println!("Action required: {s}");
                    }
                    _ => println!("Action required: yes"),
                }
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
mod inbox_json_hints_tests {
    use super::{
        build_check_json, build_review_json, inbox_json_hints, InboxDispositionCounts,
        InboxSurfaceMode, RefreshPreviewRow,
    };
    use crate::sync::SyncResult;

    fn sample_row(from: &str, id_suffix: &str) -> RefreshPreviewRow {
        RefreshPreviewRow {
            message_id: format!("<{id_suffix}@x>"),
            date: "2024-01-01T00:00:00Z".to_string(),
            from_address: from.to_string(),
            from_name: None,
            subject: "s".to_string(),
            snippet: "body".to_string(),
            note: None,
            attachments: None,
            category: None,
            action: None,
            matched_rule_ids: vec![],
            decision_source: None,
            requires_user_action: false,
            action_summary: None,
        }
    }

    fn empty_sync() -> SyncResult {
        SyncResult {
            synced: 0,
            messages_fetched: 0,
            bytes_downloaded: 0,
            duration_ms: 0,
            bandwidth_bytes_per_sec: 0.0,
            messages_per_minute: 0.0,
            log_path: "/tmp/zmail-sync.log".to_string(),
            early_exit: None,
            new_message_ids: None,
        }
    }

    #[test]
    fn empty_surfaced_returns_no_hints() {
        let hints = inbox_json_hints(
            InboxSurfaceMode::Check,
            &[],
            &InboxDispositionCounts::default(),
            0,
            false,
        );
        assert!(hints.is_empty());
    }

    #[test]
    fn empty_surfaced_still_hints_when_action_required() {
        let hints = inbox_json_hints(
            InboxSurfaceMode::Check,
            &[],
            &InboxDispositionCounts {
                notify: 0,
                inform: 3,
                ignore: 0,
                action_required: 2,
            },
            3,
            false,
        );
        assert_eq!(hints.len(), 1);
        assert!(hints[0].contains("need your action"));
        assert!(hints[0].contains("zmail inbox"));
    }

    #[test]
    fn concentration_hint_when_one_sender_dominates() {
        let mut rows: Vec<RefreshPreviewRow> = (0..10)
            .map(|i| sample_row("bulk@corp.com", &format!("m{i}")))
            .collect();
        rows.push(sample_row("other@else.com", "other"));
        let hints = inbox_json_hints(
            InboxSurfaceMode::Review,
            &rows,
            &InboxDispositionCounts {
                notify: 2,
                inform: 8,
                ignore: 1,
                action_required: 0,
            },
            50,
            true,
        );
        assert!(
            hints.iter().any(|h| h.contains("bulk@corp.com")),
            "{hints:?}"
        );
    }

    #[test]
    fn diagnostics_hint_when_not_verbose() {
        let rows = vec![sample_row("a@b.com", "one")];
        let hints = inbox_json_hints(
            InboxSurfaceMode::Check,
            &rows,
            &InboxDispositionCounts {
                notify: 1,
                inform: 0,
                ignore: 0,
                action_required: 0,
            },
            1,
            false,
        );
        assert!(hints.iter().any(|h| h.contains("--diagnostics")));
    }

    #[test]
    fn no_diagnostics_hint_when_diagnostics_enabled() {
        let rows = vec![sample_row("a@b.com", "one")];
        let hints = inbox_json_hints(
            InboxSurfaceMode::Check,
            &rows,
            &InboxDispositionCounts {
                notify: 1,
                inform: 0,
                ignore: 0,
                action_required: 0,
            },
            1,
            true,
        );
        assert!(!hints.iter().any(|h| h.contains("--diagnostics")));
    }

    #[test]
    fn large_surfaced_hint() {
        let rows: Vec<_> = (0..super::INBOX_HINTS_LARGE_SURFACED)
            .map(|i| sample_row(&format!("u{i}@x.com"), &format!("m{i}")))
            .collect();
        let hints = inbox_json_hints(
            InboxSurfaceMode::Review,
            &rows,
            &InboxDispositionCounts::default(),
            100,
            true,
        );
        assert!(hints.iter().any(|h| h.contains("Large surfaced set")));
    }

    #[test]
    fn review_json_omits_hints_when_empty() {
        let v = build_review_json(
            &[],
            None,
            &InboxDispositionCounts::default(),
            0,
            0,
            &[],
            false,
        );
        assert!(v.get("hints").is_none());
    }

    #[test]
    fn review_json_includes_hints_when_non_empty() {
        let v = build_review_json(
            &[],
            None,
            &InboxDispositionCounts::default(),
            0,
            0,
            &["one".to_string(), "two".to_string()],
            false,
        );
        assert_eq!(
            v.get("hints").and_then(|x| x.as_array()).map(|a| a.len()),
            Some(2)
        );
    }

    #[test]
    fn review_json_hints_is_last_key() {
        let mut row = sample_row("a@b.com", "x");
        row.note = Some("secret".into());
        row.decision_source = Some("model".into());
        let v = build_review_json(
            std::slice::from_ref(&row),
            None,
            &InboxDispositionCounts::default(),
            1,
            0,
            &["tip".into()],
            true,
        );
        let keys: Vec<&str> = v
            .as_object()
            .expect("object")
            .keys()
            .map(|s| s.as_str())
            .collect();
        assert_eq!(keys.last().copied(), Some("hints"));
    }

    #[test]
    fn review_json_slim_includes_requires_user_action_when_true() {
        let mut row = sample_row("a@b.com", "x");
        row.action = Some("inform".into());
        row.requires_user_action = true;
        row.action_summary = Some("Pay invoice".into());
        let v = build_review_json(
            std::slice::from_ref(&row),
            None,
            &InboxDispositionCounts::default(),
            1,
            0,
            &[],
            false,
        );
        let item = v["items"][0].as_object().expect("item object");
        assert_eq!(
            item.get("requiresUserAction").and_then(|x| x.as_bool()),
            Some(true)
        );
        assert_eq!(
            item.get("actionSummary").and_then(|x| x.as_str()),
            Some("Pay invoice")
        );
    }

    #[test]
    fn action_required_hint_when_counts_nonzero() {
        let rows = vec![sample_row("a@b.com", "one")];
        let hints = inbox_json_hints(
            InboxSurfaceMode::Review,
            &rows,
            &InboxDispositionCounts {
                notify: 1,
                inform: 0,
                ignore: 0,
                action_required: 2,
            },
            1,
            true,
        );
        assert!(
            hints.iter().any(|h| h.contains("need your action")),
            "{hints:?}"
        );
    }

    #[test]
    fn review_json_slim_omits_note_and_decision_source() {
        let mut row = sample_row("a@b.com", "x");
        row.note = Some("n".into());
        row.decision_source = Some("rule".into());
        row.matched_rule_ids = vec!["r1".into()];
        let v = build_review_json(
            std::slice::from_ref(&row),
            None,
            &InboxDispositionCounts::default(),
            1,
            0,
            &[],
            false,
        );
        let item = v["items"][0].as_object().expect("item object");
        assert!(!item.contains_key("note"));
        assert!(!item.contains_key("decisionSource"));
        assert!(!item.contains_key("matchedRuleIds"));
    }

    #[test]
    fn check_json_both_branches_merge_hints() {
        let row = sample_row("a@b.com", "x");
        let hints = vec!["hint".to_string()];
        let sync = empty_sync();
        let counts = InboxDispositionCounts::default();

        let v_full = build_check_json(
            &sync,
            std::slice::from_ref(&row),
            None,
            &counts,
            1,
            0,
            false,
            &hints,
            false,
        );
        assert_eq!(
            v_full
                .get("hints")
                .and_then(|x| x.as_array())
                .map(|a| a.len()),
            Some(1)
        );
        let keys_full: Vec<&str> = v_full
            .as_object()
            .unwrap()
            .keys()
            .map(|s| s.as_str())
            .collect();
        assert_eq!(keys_full.last().copied(), Some("hints"));

        let v_omit = build_check_json(
            &sync,
            std::slice::from_ref(&row),
            None,
            &counts,
            1,
            0,
            true,
            &hints,
            false,
        );
        assert_eq!(
            v_omit
                .get("hints")
                .and_then(|x| x.as_array())
                .map(|a| a.len()),
            Some(1)
        );
        assert!(v_omit.get("notifications").is_some());
        let keys_omit: Vec<&str> = v_omit
            .as_object()
            .unwrap()
            .keys()
            .map(|s| s.as_str())
            .collect();
        assert_eq!(keys_omit.last().copied(), Some("hints"));
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
