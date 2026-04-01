//! Read raw `.eml` from disk (`zmail read`).

use crate::ids::{resolve_message_id_and_raw_path, resolve_message_id_thread_and_raw_path};
use crate::sync::parse_message::{MailboxEntry, ReadForCli};
use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// JSON line for `zmail read --json` (includes DB `thread_id`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadMessageJson<'a> {
    pub message_id: &'a str,
    pub thread_id: &'a str,
    pub from: &'a MailboxEntry,
    pub subject: &'a str,
    pub date: &'a str,
    pub to: &'a [MailboxEntry],
    pub cc: &'a [MailboxEntry],
    pub bcc: &'a [MailboxEntry],
    pub reply_to: &'a [MailboxEntry],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<&'a str>,
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    pub references: &'a [String],
    pub recipients_disclosed: bool,
    pub body: &'a str,
}

impl<'a> ReadMessageJson<'a> {
    pub fn from_parsed(r: &'a ReadForCli, thread_id: &'a str) -> Self {
        ReadMessageJson {
            message_id: &r.message_id,
            thread_id,
            from: &r.from,
            subject: &r.subject,
            date: &r.date,
            to: &r.to,
            cc: &r.cc,
            bcc: &r.bcc,
            reply_to: &r.reply_to,
            in_reply_to: r.in_reply_to.as_deref(),
            references: &r.references,
            recipients_disclosed: r.recipients_disclosed,
            body: &r.body_text,
        }
    }
}

fn format_mailbox(m: &MailboxEntry) -> String {
    match &m.name {
        Some(n) if !n.is_empty() => format!("{n} <{}>", m.address),
        _ => m.address.clone(),
    }
}

fn format_mailboxes_line(label: &str, entries: &[MailboxEntry]) -> Option<String> {
    if entries.is_empty() {
        return None;
    }
    let s = entries
        .iter()
        .map(format_mailbox)
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!("{label}: {s}"))
}

/// Human-readable headers plus body (default `zmail read` text mode).
pub fn format_read_message_text(r: &ReadForCli) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("From: {}", format_mailbox(&r.from)));
    if r.recipients_disclosed {
        if let Some(l) = format_mailboxes_line("To", &r.to) {
            lines.push(l);
        }
        if let Some(l) = format_mailboxes_line("Cc", &r.cc) {
            lines.push(l);
        }
        if let Some(l) = format_mailboxes_line("Bcc", &r.bcc) {
            lines.push(l);
        }
    } else {
        lines.push("To: (undisclosed — no To/Cc/Bcc in message headers)".to_string());
    }
    if let Some(l) = format_mailboxes_line("Reply-To", &r.reply_to) {
        lines.push(l);
    }
    lines.push(format!("Date: {}", r.date));
    lines.push(format!("Subject: {}", r.subject));
    lines.push(format!("Message-ID: {}", r.message_id));
    if let Some(ref irt) = r.in_reply_to {
        lines.push(format!("In-Reply-To: {irt}"));
    }
    if !r.references.is_empty() {
        lines.push(format!("References: {}", r.references.join(" ")));
    }
    lines.push(String::new());
    lines.push(r.body_text.clone());
    lines.join("\n")
}

pub fn resolve_raw_path(raw_path: &str, data_dir: &Path) -> PathBuf {
    let p = Path::new(raw_path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        let direct = data_dir.join(raw_path);
        if direct.exists() || raw_path.starts_with("maildir/") {
            return direct;
        }
        let compat = data_dir.join("maildir").join(raw_path);
        if compat.exists() {
            return compat;
        }
        direct
    }
}

pub fn read_message_bytes(
    conn: &Connection,
    message_id: &str,
    data_dir: &Path,
) -> rusqlite::Result<std::io::Result<Vec<u8>>> {
    let Some((_mid, raw)) = resolve_message_id_and_raw_path(conn, message_id)? else {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    };
    let path = resolve_raw_path(&raw, data_dir);
    Ok(std::fs::read(path))
}

/// Like [`read_message_bytes`], but returns canonical `message_id` and `thread_id` from the row.
pub fn read_message_bytes_with_thread(
    conn: &Connection,
    message_id: &str,
    data_dir: &Path,
) -> rusqlite::Result<std::io::Result<(Vec<u8>, String, String)>> {
    let Some((mid, thread_id, raw)) = resolve_message_id_thread_and_raw_path(conn, message_id)?
    else {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    };
    let path = resolve_raw_path(&raw, data_dir);
    Ok(std::fs::read(path).map(|b| (b, mid, thread_id)))
}
