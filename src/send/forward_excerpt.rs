//! Forward draft body excerpt from indexed message (`load-message-body.ts`).

use std::path::Path;

use rusqlite::Connection;

use crate::ids::resolve_message_id_and_raw_path;
use crate::mail_read::resolve_raw_path;
use crate::sync::parse_raw_message;

pub struct ForwardSourceExcerpt {
    pub from_line: String,
    pub date_line: String,
    pub subject_line: String,
    pub body_text: String,
}

const FWD_SEP: &str = "---------- Forwarded message ---------";

fn format_from_parsed(from_address: &str, from_name: Option<&str>) -> String {
    match from_name {
        Some(n) if !n.trim().is_empty() && !from_address.is_empty() => {
            format!("{n} <{from_address}>")
        }
        _ if !from_address.is_empty() => from_address.to_string(),
        _ => "(unknown)".to_string(),
    }
}

fn html_to_plain_fallback(html: &str) -> String {
    html.replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n")
        .chars()
        .collect::<String>()
        .lines()
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Load plain body and metadata from the raw maildir file for a message id in the index.
pub fn load_forward_source_excerpt(
    conn: &Connection,
    data_dir: &Path,
    source_message_id: &str,
) -> Result<ForwardSourceExcerpt, String> {
    let Some((_mid, raw_path)) =
        resolve_message_id_and_raw_path(conn, source_message_id).map_err(|e| e.to_string())?
    else {
        return Err(format!("Message not found in index: {source_message_id}"));
    };
    let path = resolve_raw_path(&raw_path, data_dir);
    let buf = std::fs::read(&path)
        .map_err(|e| format!("Cannot read message at {} ({e})", path.display()))?;
    let p = parse_raw_message(&buf);
    let from_line = format_from_parsed(&p.from_address, p.from_name.as_deref());
    let date_line = chrono::DateTime::parse_from_rfc3339(&p.date)
        .ok()
        .map(|d| {
            d.with_timezone(&chrono::Utc)
                .format("%a, %d %b %Y %H:%M:%S GMT")
                .to_string()
        })
        .unwrap_or_else(|| p.date.clone());
    let mut body_text = p.body_text.trim().to_string();
    if body_text.is_empty() {
        if let Some(ref html) = p.body_html {
            body_text = htmd::convert(html).unwrap_or_else(|_| html_to_plain_fallback(html));
        }
    }
    Ok(ForwardSourceExcerpt {
        from_line,
        date_line,
        subject_line: p.subject,
        body_text,
    })
}

/// Combine optional user preamble with a standard forwarded-message block.
pub fn compose_forward_draft_body(preamble: &str, excerpt: &ForwardSourceExcerpt) -> String {
    let pre = preamble.replace("\r\n", "\n").trim_end().to_string();
    let mut lines: Vec<String> = Vec::new();
    if !pre.is_empty() {
        lines.push(pre);
        lines.push(String::new());
    }
    lines.push(FWD_SEP.into());
    lines.push(format!("From: {}", excerpt.from_line));
    if !excerpt.date_line.is_empty() {
        lines.push(format!("Date: {}", excerpt.date_line));
    }
    if !excerpt.subject_line.is_empty() {
        lines.push(format!("Subject: {}", excerpt.subject_line));
    }
    lines.push(String::new());
    lines.push(if excerpt.body_text.trim().is_empty() {
        "(no body text)".into()
    } else {
        excerpt.body_text.clone()
    });
    lines.join("\n")
}
