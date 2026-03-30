//! Outbound mail — drafts, SMTP resolve, threading (`src/send` subset).

pub mod draft_body;
pub mod draft_store;
pub mod recipients;
pub mod smtp_resolve;
pub mod smtp_send;
pub mod threading;

pub use draft_body::draft_markdown_to_plain_text;
pub use draft_store::{
    archive_draft_to_sent, list_drafts, normalize_draft_filename, read_draft, write_draft,
    DraftFile, DraftListFull, DraftListSlim, DraftMeta,
};
pub use recipients::{
    assert_send_recipients_allowed, filter_recipients_send_test, split_address_list,
    SendTestMode, DEV_SEND_ALLOWLIST,
};
pub use smtp_resolve::resolve_smtp_for_imap_host;
pub use smtp_send::{send_simple_message, verify_smtp_credentials, SendResult, SendSimpleFields};
pub use threading::extract_threading_headers;

use crate::config::Config;
use crate::mail_read::resolve_raw_path;
use crate::sync::parse_raw_message;
use rusqlite::Connection;
use std::path::Path;

#[derive(Debug, Clone, Default)]
pub struct SendPlan {
    pub to: Vec<String>,
    pub subject: String,
    pub body: String,
    pub dry_run: bool,
}

/// Back-compat: validates plan; real send uses [`send_simple_message`].
pub fn plan_send(plan: &SendPlan) -> Result<(), String> {
    if plan.dry_run {
        return Ok(());
    }
    if plan.to.is_empty() {
        return Err("no recipients".into());
    }
    Err("use send_simple_message with Config (SMTP is implemented)".into())
}

/// Send a draft by id from `{data_dir}/drafts/{id}.md` (`.md` optional in id).
pub fn send_draft_by_id(
    conn: &Connection,
    cfg: &Config,
    data_dir: &Path,
    draft_id: &str,
    dry_run: bool,
) -> Result<SendResult, String> {
    let base = normalize_draft_filename(draft_id);
    let path = data_dir.join("drafts").join(format!("{base}.md"));
    let draft = read_draft(&path).map_err(|e| format!("Draft not found: {base} ({e})"))?;

    let to_raw = draft.meta.to.as_deref().unwrap_or("").trim();
    if to_raw.is_empty() {
        return Err("Draft has no recipients (to:)".into());
    }
    let to = split_address_list(to_raw);
    if to.is_empty() {
        return Err("Draft has no recipients (to:)".into());
    }

    let cc = draft
        .meta
        .cc
        .as_deref()
        .map(|s| split_address_list(s))
        .filter(|v| !v.is_empty());
    let bcc = draft
        .meta
        .bcc
        .as_deref()
        .map(|s| split_address_list(s))
        .filter(|v| !v.is_empty());

    let mut in_reply_to = draft.meta.in_reply_to.clone();
    let mut references = draft.meta.references.clone();

    if draft.meta.kind.as_deref() == Some("reply")
        && draft.meta.source_message_id.as_ref().is_some_and(|s| !s.trim().is_empty())
    {
        let sid = draft.meta.source_message_id.as_ref().unwrap().trim();
        match load_threading_from_source_message(conn, data_dir, sid) {
            Ok((irt, refs)) => {
                in_reply_to = Some(irt);
                references = Some(refs);
            }
            Err(e) => {
                let has_fm = in_reply_to
                    .as_ref()
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false);
                if !has_fm {
                    return Err(e);
                }
            }
        }
    }

    let text = draft_markdown_to_plain_text(&draft.body);
    let subject = draft
        .meta
        .subject
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "(no subject)".into());

    let fields = SendSimpleFields {
        to,
        cc,
        bcc,
        subject,
        text,
        in_reply_to,
        references,
    };

    let result = send_simple_message(cfg, &fields, dry_run)?;
    if !dry_run && result.ok {
        let _ = archive_draft_to_sent(data_dir, &base);
    }
    Ok(result)
}

fn ensure_brackets(id: &str) -> String {
    let t = id.trim();
    if t.is_empty() {
        return String::new();
    }
    if t.starts_with('<') && t.ends_with('>') {
        t.to_string()
    } else {
        format!("<{t}>")
    }
}

/// Normalize stored message id for SQL lookup (angle brackets).
pub fn normalize_message_id(id: &str) -> String {
    let t = id.trim();
    if t.is_empty() {
        return id.to_string();
    }
    if t.starts_with('<') && t.ends_with('>') {
        t.to_string()
    } else {
        format!("<{t}>")
    }
}

/// Load In-Reply-To / References from the source message raw `.eml` (reply threading).
pub fn load_threading_from_source_message(
    conn: &Connection,
    data_dir: &Path,
    source_message_id: &str,
) -> Result<(String, String), String> {
    let mid = normalize_message_id(source_message_id);
    let raw_path: String = conn
        .query_row(
            "SELECT raw_path FROM messages WHERE message_id = ?1",
            [&mid],
            |r| r.get(0),
        )
        .map_err(|_| {
            format!(
                "Cannot build reply threading: source message {source_message_id} is not in the local index. Run zmail sync or zmail refresh, then try again."
            )
        })?;
    let path = resolve_raw_path(&raw_path, data_dir);
    let buf = std::fs::read(&path).map_err(|e| {
        format!(
            "Cannot build reply threading: could not read source message at {} ({e})",
            path.display()
        )
    })?;
    threading_headers_for_reply(&buf)
}

fn threading_headers_for_reply(raw: &[u8]) -> Result<(String, String), String> {
    let parsed = parse_raw_message(raw);
    let orig = ensure_brackets(parsed.message_id.trim());
    if orig.len() <= 2 {
        return Err("Cannot build reply threading: source message has no Message-ID.".into());
    }
    let (_, ref_ids) = extract_threading_headers(raw);
    let mut refs_parts: Vec<String> = ref_ids
        .into_iter()
        .map(|s| ensure_brackets(&s))
        .collect();
    if !refs_parts.iter().any(|x| x == &orig) {
        refs_parts.push(orig.clone());
    }
    let references = refs_parts.join(" ");
    Ok((orig.clone(), references))
}
