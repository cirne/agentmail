//! Outbound mail — drafts, SMTP resolve, threading (`src/send` subset).

pub mod draft_body;
pub mod draft_list_json;
pub mod draft_llm;
pub mod draft_store;
pub mod forward_excerpt;
pub mod recipients;
pub mod smtp_resolve;
pub mod smtp_send;
pub mod threading;

pub use draft_body::draft_markdown_to_plain_text;
pub use draft_list_json::build_draft_list_json_payload;
pub use draft_llm::{
    compose_new_draft_from_instruction, rewrite_draft_with_instruction, RewriteDraftResult,
};
pub use draft_store::{
    archive_draft_to_sent, create_draft_id, draft_body_preview, draft_file_to_json,
    draft_list_slim_hint, format_draft_not_found_message, format_draft_view_text, list_draft_rows,
    list_drafts, normalize_draft_filename, read_draft, read_draft_in_data_dir, subject_to_slug,
    write_draft, DraftFile, DraftListFull, DraftListRow, DraftListSlim, DraftMeta,
};
pub use forward_excerpt::{
    compose_forward_draft_body, load_forward_source_excerpt, ForwardSourceExcerpt,
};
pub use recipients::{
    assert_send_recipients_allowed, filter_recipients_send_test, split_address_list, SendTestMode,
    DEV_SEND_ALLOWLIST,
};
pub use smtp_resolve::resolve_smtp_for_imap_host;
pub use smtp_send::{send_simple_message, verify_smtp_credentials, SendResult, SendSimpleFields};
pub use threading::extract_threading_headers;

use crate::config::Config;
use crate::db;
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
///
/// Opens the SQLite index only when the draft is a **reply** and needs In-Reply-To / References
/// from the source message. **Forward** and **new** drafts do not touch the DB, so `zmail send
/// <id>` stays responsive when another process holds the DB (e.g. background sync).
pub fn send_draft_by_id(
    cfg: &Config,
    data_dir: &Path,
    draft_id: &str,
    dry_run: bool,
) -> Result<SendResult, String> {
    let draft = read_draft_in_data_dir(data_dir, draft_id).map_err(|e| e.to_string())?;

    let to = draft
        .meta
        .to
        .as_ref()
        .filter(|v| !v.is_empty())
        .cloned()
        .ok_or_else(|| "Draft has no recipients (to:)".to_string())?;

    let cc = draft.meta.cc.as_ref().filter(|v| !v.is_empty()).cloned();
    let bcc = draft.meta.bcc.as_ref().filter(|v| !v.is_empty()).cloned();

    let mut in_reply_to = draft.meta.in_reply_to.clone();
    let mut references = draft.meta.references.clone();

    if draft.meta.kind.as_deref() == Some("reply")
        && draft
            .meta
            .source_message_id
            .as_ref()
            .is_some_and(|s| !s.trim().is_empty())
    {
        let sid = draft.meta.source_message_id.as_ref().unwrap().trim();
        let conn = db::open_file(cfg.db_path()).map_err(|e| e.to_string())?;
        match load_threading_from_source_message(&conn, data_dir, sid) {
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
        let _ = archive_draft_to_sent(data_dir, &draft.id);
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

pub use crate::ids::normalize_message_id;

/// Load In-Reply-To / References from the source message raw `.eml` (reply threading).
pub fn load_threading_from_source_message(
    conn: &Connection,
    data_dir: &Path,
    source_message_id: &str,
) -> Result<(String, String), String> {
    let Some((_mid, raw_path)) =
        crate::ids::resolve_message_id_and_raw_path(conn, source_message_id)
            .map_err(|e| e.to_string())?
    else {
        return Err(format!(
            "Cannot build reply threading: source message {source_message_id} is not in the local index. Run zmail sync or zmail refresh, then try again."
        ));
    };
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
    let mut refs_parts: Vec<String> = ref_ids.into_iter().map(|s| ensure_brackets(&s)).collect();
    if !refs_parts.iter().any(|x| x == &orig) {
        refs_parts.push(orig.clone());
    }
    let references = refs_parts.join(" ");
    Ok((orig.clone(), references))
}
