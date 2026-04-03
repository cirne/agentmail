//! Notable-mail LLM scan (`src/inbox/scan.ts`).

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use std::time::Instant;

use regex::Regex;

use async_openai::config::OpenAIConfig;
use async_openai::types::{
    ChatCompletionRequestMessage, ChatCompletionRequestSystemMessage,
    ChatCompletionRequestSystemMessageContent, ChatCompletionRequestUserMessage,
    ChatCompletionRequestUserMessageContent, CreateChatCompletionRequestArgs, ResponseFormat,
};
use async_openai::Client as OpenAiClient;
use async_trait::async_trait;
use rusqlite::Connection;
use serde_json::json;

use crate::attachments::{list_attachments_for_message, AttachmentListRow};
use crate::inbox::state::{
    already_surfaced_filter_sql, load_cached_inbox_decisions, persist_inbox_decisions,
    record_inbox_scan, InboxSurfaceMode,
};
use crate::mail_category::{is_default_excluded_category, CATEGORY_LIST};
use crate::refresh::{InboxDispositionCounts, RefreshPreviewAttachment, RefreshPreviewRow};
use crate::rules::{build_inbox_rules_prompt, rules_fingerprint, RulesFile};
use crate::search::{
    infer_name_from_address, is_noreply, normalize_address, sort_rows_by_sender_contact_rank,
};

const DEFAULT_CANDIDATE_CAP: usize = 80;
const DEFAULT_NOTABLE_CAP: usize = 10;
const DEFAULT_REVIEW_NOTABLE_CAP: usize = 30;
const DEFAULT_BATCH_SIZE: usize = 40;
const DEFAULT_INBOX_PREFETCH_CAP: usize = 200;

const NANO_MODEL: &str = "gpt-4.1-nano";

/// List-management boilerplate (word boundary; avoids accidental substrings).
static UNSUBSCRIBE_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bunsubscribe\b").expect("unsubscribe word regex"));

/// Bounded prefetch: `min(2 * candidate_cap, 200)` — matches Node `inboxCandidatePrefetchLimit`.
pub fn inbox_candidate_prefetch_limit(candidate_cap: usize) -> usize {
    candidate_cap
        .saturating_mul(2)
        .min(DEFAULT_INBOX_PREFETCH_CAP)
}

#[derive(Debug, Clone)]
pub struct InboxCandidate {
    pub message_id: String,
    pub date: String,
    pub from_address: String,
    pub from_name: Option<String>,
    pub to_addresses: Vec<String>,
    pub cc_addresses: Vec<String>,
    pub subject: String,
    pub snippet: String,
    pub category: Option<String>,
    pub attachments: Vec<AttachmentListRow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxNotablePick {
    pub message_id: String,
    pub action: Option<String>,
    pub matched_rule_ids: Vec<String>,
    pub note: Option<String>,
    pub decision_source: Option<String>,
}

#[derive(Debug)]
pub struct RunInboxScanResult {
    pub surfaced: Vec<RefreshPreviewRow>,
    pub processed: Vec<RefreshPreviewRow>,
    pub counts: InboxDispositionCounts,
    pub candidates_scanned: usize,
    pub llm_duration_ms: u64,
}

#[derive(Debug, Clone)]
pub struct RuleImpactPreview {
    pub matched: Vec<RefreshPreviewRow>,
    pub candidates_scanned: usize,
    pub llm_duration_ms: u64,
}

#[derive(Debug, Clone, Default)]
pub struct RunInboxScanOptions {
    pub surface_mode: InboxSurfaceMode,
    pub cutoff_iso: String,
    pub include_all: bool,
    pub replay: bool,
    /// When true (`--thorough` or `--reclassify`), candidate SQL includes archived rows so the LLM can re-decide.
    pub reapply_llm: bool,
    pub diagnostics: bool,
    pub rules_fingerprint: Option<String>,
    pub owner_address: Option<String>,
    pub owner_aliases: Vec<String>,
    pub candidate_cap: Option<usize>,
    pub notable_cap: Option<usize>,
    pub batch_size: Option<usize>,
}

#[derive(Debug, Clone, Default)]
pub struct InboxOwnerContext {
    pub primary_address: Option<String>,
    pub alias_addresses: Vec<String>,
    pub display_name: Option<String>,
}

impl InboxOwnerContext {
    pub fn from_addresses(primary_address: Option<&str>, alias_addresses: &[String]) -> Self {
        let primary_address = primary_address
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let mut seen = HashSet::new();
        let mut deduped_aliases = Vec::new();
        for alias in alias_addresses {
            let trimmed = alias.trim();
            if trimmed.is_empty() {
                continue;
            }
            let normalized = normalize_address(trimmed);
            if primary_address
                .as_deref()
                .is_some_and(|primary| normalize_address(primary) == normalized)
            {
                continue;
            }
            if seen.insert(normalized) {
                deduped_aliases.push(trimmed.to_string());
            }
        }
        let display_name = primary_address.as_deref().and_then(infer_name_from_address);
        Self {
            primary_address,
            alias_addresses: deduped_aliases,
            display_name,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RunInboxScanError {
    #[error("SQLite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("OpenAI: {0}")]
    OpenAI(#[from] async_openai::error::OpenAIError),
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Rules: {0}")]
    Rules(#[from] crate::rules::RulesError),
    #[error("Inbox window: {0}")]
    InvalidWindow(String),
}

#[async_trait]
pub trait InboxBatchClassifier: Send {
    async fn classify_batch(
        &mut self,
        batch: Vec<InboxCandidate>,
    ) -> Result<Vec<InboxNotablePick>, RunInboxScanError>;
}

/// Production classifier: `gpt-4.1-nano` with JSON object response.
pub struct OpenAiInboxClassifier {
    client: OpenAiClient<OpenAIConfig>,
    system_prompt: String,
}

impl OpenAiInboxClassifier {
    pub fn new(
        api_key: &str,
        rules: &RulesFile,
        diagnostics: bool,
        owner: &InboxOwnerContext,
    ) -> Self {
        let config = OpenAIConfig::new().with_api_key(api_key);
        Self {
            client: OpenAiClient::with_config(config),
            system_prompt: build_inbox_rules_prompt(rules, diagnostics, owner),
        }
    }

    pub fn rules_fingerprint(rules: &RulesFile) -> String {
        rules_fingerprint(rules)
    }
}

#[async_trait]
impl InboxBatchClassifier for OpenAiInboxClassifier {
    async fn classify_batch(
        &mut self,
        batch: Vec<InboxCandidate>,
    ) -> Result<Vec<InboxNotablePick>, RunInboxScanError> {
        if batch.is_empty() {
            return Ok(Vec::new());
        }
        let payload: Vec<serde_json::Value> = batch
            .iter()
            .map(|c| {
                let from_line = match &c.from_name {
                    Some(n) if !n.is_empty() => format!("{} <{}>", n, c.from_address),
                    _ => c.from_address.clone(),
                };
                let mut o = serde_json::Map::new();
                o.insert("messageId".into(), json!(c.message_id));
                o.insert("date".into(), json!(c.date));
                o.insert("fromAddress".into(), json!(c.from_address));
                o.insert("fromName".into(), json!(c.from_name));
                o.insert("from".into(), json!(from_line));
                o.insert("to".into(), json!(c.to_addresses));
                o.insert("cc".into(), json!(c.cc_addresses));
                o.insert("subject".into(), json!(c.subject));
                o.insert(
                    "snippet".into(),
                    json!(c.snippet.chars().take(400).collect::<String>()),
                );
                if let Some(category) = &c.category {
                    o.insert("category".into(), json!(category));
                }
                if !c.attachments.is_empty() {
                    let atts: Vec<serde_json::Value> = c
                        .attachments
                        .iter()
                        .map(|a| {
                            json!({
                                "filename": a.filename,
                                "mimeType": a.mime_type,
                            })
                        })
                        .collect();
                    o.insert("attachments".into(), serde_json::Value::Array(atts));
                }
                Ok::<serde_json::Value, serde_json::Error>(serde_json::Value::Object(o))
            })
            .collect::<Result<Vec<_>, _>>()?;

        let req = CreateChatCompletionRequestArgs::default()
            .model(NANO_MODEL)
            .messages(vec![
                ChatCompletionRequestMessage::System(ChatCompletionRequestSystemMessage {
                    content: ChatCompletionRequestSystemMessageContent::Text(
                        self.system_prompt.clone(),
                    ),
                    name: None,
                }),
                ChatCompletionRequestMessage::User(ChatCompletionRequestUserMessage {
                    content: ChatCompletionRequestUserMessageContent::Text(serde_json::to_string(
                        &payload,
                    )?),
                    name: None,
                }),
            ])
            .response_format(ResponseFormat::JsonObject)
            .build()?;

        let completion = self.client.chat().create(req).await?;
        let text = completion
            .choices
            .into_iter()
            .next()
            .and_then(|c| c.message.content)
            .unwrap_or_default();
        let text = text.trim();
        parse_notable_response(text, &batch)
    }
}

/// Test helper: synchronous closure wrapped as async classifier.
pub struct MockInboxClassifier<F>
where
    F: FnMut(Vec<InboxCandidate>) -> Vec<InboxNotablePick> + Send,
{
    pub f: F,
}

impl<F> MockInboxClassifier<F>
where
    F: FnMut(Vec<InboxCandidate>) -> Vec<InboxNotablePick> + Send,
{
    pub fn new(f: F) -> Self {
        Self { f }
    }
}

#[async_trait]
impl<F> InboxBatchClassifier for MockInboxClassifier<F>
where
    F: FnMut(Vec<InboxCandidate>) -> Vec<InboxNotablePick> + Send,
{
    async fn classify_batch(
        &mut self,
        batch: Vec<InboxCandidate>,
    ) -> Result<Vec<InboxNotablePick>, RunInboxScanError> {
        Ok((self.f)(batch))
    }
}

fn strip_snippet_html(s: &str) -> String {
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

/// True when `from_address` matches the configured account primary or an IMAP alias (normalized).
fn is_from_owner(
    from_address: &str,
    owner_address: Option<&str>,
    owner_aliases: &[String],
) -> bool {
    let Some(primary) = owner_address.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    let from_norm = normalize_address(from_address.trim());
    if from_norm.is_empty() {
        return false;
    }
    if normalize_address(primary) == from_norm {
        return true;
    }
    owner_aliases.iter().any(|a| {
        let t = a.trim();
        !t.is_empty() && normalize_address(t) == from_norm
    })
}

/// Cheap bulk heuristics used when the model JSON is missing or invalid (`decision_source: fallback`).
/// `note` explains which signal fired; `action` mirrors the same branch ordering as historical `fallback_action`.
#[derive(Clone, Copy)]
struct FallbackHeuristic {
    action: &'static str,
    note: &'static str,
}

fn evaluate_fallback_heuristic(candidate: &InboxCandidate) -> FallbackHeuristic {
    if candidate.category.as_deref().is_some_and(|category| {
        category == CATEGORY_LIST || is_default_excluded_category(Some(category))
    }) {
        return FallbackHeuristic {
            action: "ignore",
            note: "Heuristic: list or excluded provider category.",
        };
    }

    let from_address = candidate.from_address.to_ascii_lowercase();
    let subject = candidate.subject.to_ascii_lowercase();
    let snippet = candidate.snippet.to_ascii_lowercase();
    let automated_subject = [
        "newsletter",
        "digest",
        "sale",
        "deal alert",
        "invitation",
        "invitations",
        "sitewide",
        "membership",
        "available",
        "document(s) available",
    ]
    .iter()
    .any(|needle| subject.contains(needle));
    let automated_snippet = ["view in browser", "unsubscribe", "manage preferences"]
        .iter()
        .any(|needle| snippet.contains(needle));

    if is_noreply(&from_address) {
        return FallbackHeuristic {
            action: "ignore",
            note: "Heuristic: noreply-style sender address.",
        };
    }
    if from_address.contains("newsletter") {
        return FallbackHeuristic {
            action: "ignore",
            note: "Heuristic: sender address looks like newsletter traffic.",
        };
    }
    if from_address.contains("linkedin") {
        return FallbackHeuristic {
            action: "ignore",
            note: "Heuristic: sender address looks like LinkedIn traffic.",
        };
    }
    if automated_subject {
        return FallbackHeuristic {
            action: "ignore",
            note: "Heuristic: subject suggests marketing or automated bulk mail.",
        };
    }
    if automated_snippet {
        return FallbackHeuristic {
            action: "ignore",
            note: "Heuristic: snippet suggests list or marketing boilerplate (unsubscribe, view in browser, or preferences).",
        };
    }

    FallbackHeuristic {
        action: "inform",
        note: "Heuristic: ambiguous or non-bulk mail; defaulting to inform.",
    }
}

fn fallback_action(candidate: &InboxCandidate) -> &'static str {
    evaluate_fallback_heuristic(candidate).action
}

fn note_is_empty(note: &Option<String>) -> bool {
    note.as_deref()
        .map(str::trim)
        .map(|s| s.is_empty())
        .unwrap_or(true)
}

fn local_archive_signals_hint(
    row: &RefreshPreviewRow,
    owner_address: Option<&str>,
    owner_aliases: &[String],
) -> &'static str {
    if is_from_owner(&row.from_address, owner_address, owner_aliases) {
        return "message sent from your address";
    }
    if !row.matched_rule_ids.is_empty() {
        return "user rule matched";
    }
    if is_default_excluded_category(row.category.as_deref()) {
        return "excluded provider category";
    }
    if is_noreply(&row.from_address) {
        return "noreply-style sender";
    }
    let subj = row.subject.to_ascii_lowercase();
    let snip = row.snippet.to_ascii_lowercase();
    if UNSUBSCRIBE_WORD.is_match(&subj) || UNSUBSCRIBE_WORD.is_match(&snip) {
        return "unsubscribe word in subject or snippet";
    }
    "local archive conditions matched"
}

fn synthesize_default_note(candidate: &InboxCandidate, row: &RefreshPreviewRow) -> String {
    match row.decision_source.as_deref() {
        Some("model") => {
            let a = row.action.as_deref().unwrap_or("inform");
            format!("Model classified as {a} (no note).")
        }
        Some("rule") => {
            if row.matched_rule_ids.is_empty() {
                "Matched user rule.".to_string()
            } else {
                format!("Matched user rule(s): {}.", row.matched_rule_ids.join(", "))
            }
        }
        Some("fallback") => evaluate_fallback_heuristic(candidate).note.to_string(),
        Some("stripper") => "Ignore overruled; not bulk.".to_string(),
        Some("cached") => "Cached decision from previous scan.".to_string(),
        Some("heuristic") => "Heuristic classification (no note).".to_string(),
        _ => format!(
            "Classified as {}.",
            row.action.as_deref().unwrap_or("inform")
        ),
    }
}

fn finalize_preview_note(
    candidate: &InboxCandidate,
    row: &mut RefreshPreviewRow,
    owner_address: Option<&str>,
    owner_aliases: &[String],
) {
    if note_is_empty(&row.note) {
        row.note = Some(synthesize_default_note(candidate, row));
    }
    if row.action.as_deref() == Some("ignore")
        && ignore_should_apply_local_archive(row, owner_address, owner_aliases)
    {
        let n = row.note.as_deref().unwrap_or("");
        if !n.to_ascii_lowercase().contains("local archive") {
            let hint = local_archive_signals_hint(row, owner_address, owner_aliases);
            row.note = Some(format!("{n} Local archive: {hint}."));
        }
    }
}

fn parse_notable_response(
    text: &str,
    batch: &[InboxCandidate],
) -> Result<Vec<InboxNotablePick>, RunInboxScanError> {
    let fallback_pick = |candidate: &InboxCandidate, note: &str| InboxNotablePick {
        message_id: candidate.message_id.clone(),
        action: Some(fallback_action(candidate).into()),
        matched_rule_ids: vec![],
        note: Some(note.into()),
        decision_source: Some("fallback".into()),
    };
    let allowed: HashSet<&str> = batch.iter().map(|b| b.message_id.as_str()).collect();
    let parsed: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => {
            return Ok(batch
                .iter()
                .map(|candidate| {
                    let h = evaluate_fallback_heuristic(candidate);
                    fallback_pick(
                        candidate,
                        &format!("{} Fallback: model returned invalid JSON.", h.note),
                    )
                })
                .collect())
        }
    };
    let notable = match parsed.get("results") {
        Some(n) => n,
        None => {
            return Ok(batch
                .iter()
                .map(|candidate| {
                    let h = evaluate_fallback_heuristic(candidate);
                    fallback_pick(
                        candidate,
                        &format!("{} Fallback: model omitted results.", h.note),
                    )
                })
                .collect())
        }
    };
    let arr = match notable.as_array() {
        Some(a) => a,
        None => {
            return Ok(batch
                .iter()
                .map(|candidate| {
                    let h = evaluate_fallback_heuristic(candidate);
                    fallback_pick(
                        candidate,
                        &format!(
                            "{} Fallback: model returned a malformed results payload.",
                            h.note
                        ),
                    )
                })
                .collect())
        }
    };
    let mut out = Vec::new();
    for item in arr {
        let mid = item.get("messageId").and_then(|x| x.as_str());
        let Some(mid) = mid else { continue };
        if !allowed.contains(mid) {
            continue;
        }
        let action = item
            .get("action")
            .and_then(|x| x.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let matched_rule_ids = item
            .get("matchedRuleIds")
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|value| value.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let note = item
            .get("note")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let decision_source = if matched_rule_ids.is_empty() {
            Some("model".to_string())
        } else {
            Some("rule".to_string())
        };
        out.push(InboxNotablePick {
            message_id: mid.to_string(),
            action,
            matched_rule_ids,
            note,
            decision_source,
        });
    }
    let seen: HashSet<String> = out.iter().map(|item| item.message_id.clone()).collect();
    for candidate in batch {
        if seen.contains(&candidate.message_id) {
            continue;
        }
        let h = evaluate_fallback_heuristic(candidate);
        out.push(InboxNotablePick {
            message_id: candidate.message_id.clone(),
            action: Some(h.action.into()),
            matched_rule_ids: vec![],
            note: Some(format!("{} Model response omitted this message.", h.note)),
            decision_source: Some("fallback".into()),
        });
    }
    Ok(out)
}

fn list_to_preview_attachments(rows: Vec<AttachmentListRow>) -> Vec<RefreshPreviewAttachment> {
    rows.into_iter()
        .map(|a| RefreshPreviewAttachment {
            id: a.id,
            filename: a.filename,
            mime_type: a.mime_type,
            index: a.index,
        })
        .collect()
}

fn normalize_action(action: Option<&str>) -> &'static str {
    match action
        .unwrap_or("inform")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "notify" => "notify",
        "inform" => "inform",
        "ignore" => "ignore",
        "suppress" | "archive" => "ignore",
        _ => "inform",
    }
}

fn surface_matches(mode: InboxSurfaceMode, action: &str) -> bool {
    match mode {
        InboxSurfaceMode::Check => action == "notify",
        // Full inbox snapshot for the window: include notify, inform, and ignore so nothing is hidden.
        InboxSurfaceMode::Review => matches!(action, "notify" | "inform" | "ignore"),
    }
}

/// Whether an LLM `ignore` should set local `is_archived`.
///
/// Conservative: honor explicit user rules, provider category (sync metadata), noreply-style
/// senders, unsubscribe boilerplate, or mail sent from the user's own address — not long
/// marketing-keyword lists.
fn ignore_should_apply_local_archive(
    row: &RefreshPreviewRow,
    owner_address: Option<&str>,
    owner_aliases: &[String],
) -> bool {
    if is_from_owner(&row.from_address, owner_address, owner_aliases) {
        return true;
    }
    if !row.matched_rule_ids.is_empty() {
        return true;
    }
    if is_default_excluded_category(row.category.as_deref()) {
        return true;
    }
    if is_noreply(&row.from_address) {
        return true;
    }
    let subj = row.subject.to_ascii_lowercase();
    let snip = row.snippet.to_ascii_lowercase();
    UNSUBSCRIBE_WORD.is_match(&subj) || UNSUBSCRIBE_WORD.is_match(&snip)
}

fn to_preview_row(
    candidate: &InboxCandidate,
    pick: InboxNotablePick,
    owner_address: Option<&str>,
    owner_aliases: &[String],
) -> RefreshPreviewRow {
    let attachments = if candidate.attachments.is_empty() {
        None
    } else {
        Some(list_to_preview_attachments(candidate.attachments.clone()))
    };
    let mut action = normalize_action(pick.action.as_deref()).to_string();
    let mut decision_source = pick.decision_source;
    let mut note = pick.note;

    // If the model says `ignore` but cheap bulk heuristics would not, prefer `inform`.
    // Uses the same signals as parser fallback — no domain-specific keywords.
    if action == "ignore"
        && pick.matched_rule_ids.is_empty()
        && fallback_action(candidate) == "inform"
        && !is_from_owner(&candidate.from_address, owner_address, owner_aliases)
    {
        action = "inform".into();
        decision_source = Some("stripper".into());
        let hint = "Ignore overruled; not bulk.";
        note = Some(match note {
            Some(n) if !n.trim().is_empty() => format!("{n} ({hint})"),
            _ => hint.to_string(),
        });
    }

    if is_from_owner(&candidate.from_address, owner_address, owner_aliases) {
        action = "ignore".into();
        decision_source = Some("heuristic".into());
        let self_note = "Heuristic: message sent from your address; treating as ignore.";
        note = Some(match note {
            Some(n) if !n.trim().is_empty() => format!("{n} ({self_note})"),
            _ => self_note.to_string(),
        });
    }

    let mut row = RefreshPreviewRow {
        message_id: candidate.message_id.clone(),
        date: candidate.date.clone(),
        from_address: candidate.from_address.clone(),
        from_name: candidate.from_name.clone(),
        subject: candidate.subject.clone(),
        snippet: candidate.snippet.clone(),
        note,
        attachments,
        category: candidate.category.clone(),
        action: Some(action),
        matched_rule_ids: pick.matched_rule_ids.clone(),
        decision_source,
    };
    finalize_preview_note(candidate, &mut row, owner_address, owner_aliases);
    row
}

fn load_inbox_candidates(
    conn: &Connection,
    options: &RunInboxScanOptions,
) -> Result<Vec<InboxCandidate>, RunInboxScanError> {
    let candidate_cap = options.candidate_cap.unwrap_or(DEFAULT_CANDIDATE_CAP);
    let category_sql = if options.include_all {
        String::new()
    } else {
        format!(
            " AND {}",
            crate::mail_category::default_category_filter_sql("messages.category")
        )
    };
    let surfaced_sql = already_surfaced_filter_sql(options.surface_mode, options.replay);
    let fetch_limit = inbox_candidate_prefetch_limit(candidate_cap);
    let archived_sql = if options.reapply_llm {
        ""
    } else {
        " AND is_archived = 0"
    };

    let sql = format!(
        "SELECT message_id, from_address, from_name, to_addresses, cc_addresses, subject, date,
         COALESCE(TRIM(SUBSTR(body_text, 1, 200)), '') ||
         CASE WHEN LENGTH(TRIM(body_text)) > 200 THEN '…' ELSE '' END AS snippet,
         category
         FROM messages
         WHERE date >= ?1
           {archived_sql}{category_sql}{surfaced_sql}
         ORDER BY date DESC
         LIMIT ?2"
    );

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(
        rusqlite::params![options.cutoff_iso, fetch_limit as i64],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, Option<String>>(8)?,
            ))
        },
    )?;

    let mut candidates: Vec<InboxCandidate> = Vec::new();
    for r in rows {
        let (
            message_id,
            from_address,
            from_name,
            to_json,
            cc_json,
            subject,
            date,
            snippet,
            category,
        ) = r?;
        let attachments = list_attachments_for_message(conn, &message_id)?;
        candidates.push(InboxCandidate {
            message_id,
            date,
            from_address,
            from_name,
            to_addresses: serde_json::from_str(&to_json).unwrap_or_default(),
            cc_addresses: serde_json::from_str(&cc_json).unwrap_or_default(),
            subject,
            snippet: strip_snippet_html(&snippet),
            category,
            attachments,
        });
    }

    candidates = sort_rows_by_sender_contact_rank(
        conn,
        options.owner_address.as_deref(),
        candidates,
        |c| &c.from_address,
        |c| &c.date,
    )?;
    candidates.truncate(candidate_cap);
    Ok(candidates)
}

async fn classify_candidates(
    candidates: &[InboxCandidate],
    batch_size: usize,
    classifier: &mut dyn InboxBatchClassifier,
    owner_address: Option<&str>,
    owner_aliases: &[String],
) -> Result<(Vec<RefreshPreviewRow>, u64), RunInboxScanError> {
    let by_id: HashMap<String, InboxCandidate> = candidates
        .iter()
        .map(|c| (c.message_id.clone(), c.clone()))
        .collect();
    let mut llm_duration_ms: u64 = 0;
    let mut merged: Vec<InboxNotablePick> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for chunk in candidates.chunks(batch_size) {
        let batch: Vec<InboxCandidate> = chunk.to_vec();
        let t0 = Instant::now();
        let picks = classifier.classify_batch(batch).await?;
        llm_duration_ms += t0.elapsed().as_millis() as u64;
        for p in picks {
            if seen.contains(&p.message_id) {
                continue;
            }
            seen.insert(p.message_id.clone());
            merged.push(p);
        }
    }

    let mut rows = Vec::new();
    for pick in merged {
        let Some(candidate) = by_id.get(&pick.message_id) else {
            continue;
        };
        rows.push(to_preview_row(
            candidate,
            pick,
            owner_address,
            owner_aliases,
        ));
    }
    Ok((rows, llm_duration_ms))
}

pub async fn preview_rule_impact(
    conn: &Connection,
    options: &RunInboxScanOptions,
    classifier: &mut dyn InboxBatchClassifier,
    rule_id: &str,
) -> Result<RuleImpactPreview, RunInboxScanError> {
    let batch_size = options.batch_size.unwrap_or(DEFAULT_BATCH_SIZE);
    let candidates = load_inbox_candidates(conn, options)?;
    let (rows, llm_duration_ms) = classify_candidates(
        &candidates,
        batch_size,
        classifier,
        options.owner_address.as_deref(),
        &options.owner_aliases,
    )
    .await?;
    let matched = rows
        .into_iter()
        .filter(|row| {
            row.matched_rule_ids
                .iter()
                .any(|matched| matched == rule_id)
        })
        .collect();
    Ok(RuleImpactPreview {
        matched,
        candidates_scanned: candidates.len(),
        llm_duration_ms,
    })
}

/// Run inbox notable scan (Node `runInboxScan`).
pub async fn run_inbox_scan(
    conn: &Connection,
    options: &RunInboxScanOptions,
    classifier: &mut dyn InboxBatchClassifier,
) -> Result<RunInboxScanResult, RunInboxScanError> {
    let candidate_cap = options.candidate_cap.unwrap_or(DEFAULT_CANDIDATE_CAP);
    let notable_cap = options.notable_cap.unwrap_or_else(|| {
        if options.surface_mode == InboxSurfaceMode::Review {
            DEFAULT_REVIEW_NOTABLE_CAP
        } else {
            DEFAULT_NOTABLE_CAP
        }
    });
    let batch_size = options.batch_size.unwrap_or(DEFAULT_BATCH_SIZE);
    let mut candidates = load_inbox_candidates(conn, options)?;
    candidates.truncate(candidate_cap);

    let by_id: HashMap<String, InboxCandidate> = candidates
        .iter()
        .map(|c| (c.message_id.clone(), c.clone()))
        .collect();
    let rules_fingerprint = options
        .rules_fingerprint
        .clone()
        .unwrap_or_else(|| "default".to_string());
    let mut cached_by_id: HashMap<String, RefreshPreviewRow> = HashMap::new();
    if !options.reapply_llm {
        let message_ids: Vec<String> = candidates.iter().map(|c| c.message_id.clone()).collect();
        for cached in load_cached_inbox_decisions(conn, &rules_fingerprint, &message_ids)? {
            let Some(candidate) = by_id.get(&cached.message_id) else {
                continue;
            };
            let row = to_preview_row(
                candidate,
                InboxNotablePick {
                    message_id: cached.message_id.clone(),
                    action: Some(cached.action),
                    matched_rule_ids: cached.matched_rule_ids,
                    note: cached.note,
                    decision_source: Some("cached".into()),
                },
                options.owner_address.as_deref(),
                &options.owner_aliases,
            );
            cached_by_id.insert(row.message_id.clone(), row);
        }
    }
    let llm_candidates: Vec<InboxCandidate> = candidates
        .iter()
        .filter(|candidate| !cached_by_id.contains_key(&candidate.message_id))
        .cloned()
        .collect();

    let (fresh_rows, llm_duration_ms) = classify_candidates(
        &llm_candidates,
        batch_size,
        classifier,
        options.owner_address.as_deref(),
        &options.owner_aliases,
    )
    .await?;

    let mut fresh_by_id: HashMap<String, RefreshPreviewRow> = HashMap::new();
    for row in fresh_rows.iter().cloned() {
        fresh_by_id.insert(row.message_id.clone(), row.clone());
    }
    persist_inbox_decisions(conn, &rules_fingerprint, &fresh_rows)?;

    let mut counts = InboxDispositionCounts::default();
    let mut surfaced: Vec<RefreshPreviewRow> = Vec::new();
    let mut processed: Vec<RefreshPreviewRow> = Vec::new();
    let mut ordered_rows: Vec<RefreshPreviewRow> = Vec::new();
    for candidate in &candidates {
        if let Some(row) = cached_by_id.remove(&candidate.message_id) {
            ordered_rows.push(row);
            continue;
        }
        if let Some(row) = fresh_by_id.remove(&candidate.message_id) {
            ordered_rows.push(row);
        }
    }
    for row in ordered_rows {
        match row.action.as_deref().unwrap_or("inform") {
            "notify" => counts.notify += 1,
            "inform" => counts.inform += 1,
            "ignore" => counts.ignore += 1,
            _ => {}
        }
        let action = normalize_action(row.action.as_deref());
        if surface_matches(options.surface_mode, action) {
            surfaced.push(row.clone());
        }
        processed.push(row);
    }

    // Sync local archive to triage action: notify/inform stay (or return to) the working set;
    // ignore archives only when broad safe-to-archive signals match.
    for row in &processed {
        let action = normalize_action(row.action.as_deref());
        match action {
            "notify" | "inform" => {
                conn.execute(
                    "UPDATE messages SET is_archived = 0 WHERE message_id = ?1",
                    [&row.message_id],
                )?;
            }
            "ignore" => {
                if ignore_should_apply_local_archive(
                    row,
                    options.owner_address.as_deref(),
                    &options.owner_aliases,
                ) {
                    conn.execute(
                        "UPDATE messages SET is_archived = 1 WHERE message_id = ?1",
                        [&row.message_id],
                    )?;
                } else {
                    conn.execute(
                        "UPDATE messages SET is_archived = 0 WHERE message_id = ?1",
                        [&row.message_id],
                    )?;
                }
            }
            _ => {}
        }
    }

    surfaced.truncate(notable_cap);

    let surfaced_message_ids: Vec<String> = surfaced.iter().map(|m| m.message_id.clone()).collect();
    record_inbox_scan(
        conn,
        options.surface_mode,
        &options.cutoff_iso,
        candidates.len(),
        &surfaced_message_ids,
    )?;

    Ok(RunInboxScanResult {
        surfaced,
        processed: if options.diagnostics {
            processed
        } else {
            Vec::new()
        },
        counts,
        candidates_scanned: candidates.len(),
        llm_duration_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use crate::persist_message;
    use crate::sync::ParsedMessage;

    #[test]
    fn prefetch_limit_80_to_160() {
        assert_eq!(inbox_candidate_prefetch_limit(80), 160);
    }

    #[test]
    fn prefetch_limit_caps_200() {
        assert_eq!(inbox_candidate_prefetch_limit(150), 200);
    }

    fn sample_preview_row(
        from: &str,
        subject: &str,
        snippet: &str,
        category: Option<&str>,
        matched: &[&str],
    ) -> RefreshPreviewRow {
        RefreshPreviewRow {
            message_id: "m".into(),
            date: "2026-01-01T00:00:00Z".into(),
            from_address: from.into(),
            from_name: None,
            subject: subject.into(),
            snippet: snippet.into(),
            note: None,
            attachments: None,
            category: category.map(str::to_string),
            action: Some("ignore".into()),
            matched_rule_ids: matched.iter().map(|s| (*s).to_string()).collect(),
            decision_source: None,
        }
    }

    #[test]
    fn ignore_archive_honors_noreply() {
        let row = sample_preview_row("no-reply@corp.com", "Hi", "body", None, &[]);
        assert!(ignore_should_apply_local_archive(&row, None, &[]));
    }

    #[test]
    fn ignore_archive_honors_unsubscribe_in_snippet() {
        let row = sample_preview_row(
            "news@corp.com",
            "Weekly",
            "Click here. Unsubscribe",
            None,
            &[],
        );
        assert!(ignore_should_apply_local_archive(&row, None, &[]));
    }

    #[test]
    fn ignore_archive_skips_plain_personal_mail() {
        let row = sample_preview_row(
            "human@example.com",
            "Flight update",
            "Departure at 2pm",
            None,
            &[],
        );
        assert!(!ignore_should_apply_local_archive(&row, None, &[]));
    }

    #[test]
    fn ignore_archive_honors_user_rule_ids() {
        let row = sample_preview_row("human@example.com", "x", "y", None, &["r1"]);
        assert!(ignore_should_apply_local_archive(&row, None, &[]));
    }

    #[test]
    fn ignore_archive_honors_mail_from_owner_address() {
        let row = sample_preview_row("LewisCirne@gmail.com", "Re: thread", "Thanks", None, &[]);
        assert!(ignore_should_apply_local_archive(
            &row,
            Some("lewiscirne@gmail.com"),
            &[]
        ));
    }

    #[test]
    fn ignore_archive_honors_mail_from_owner_alias() {
        let row = sample_preview_row("work@company.com", "Hi", "Hey", None, &[]);
        assert!(ignore_should_apply_local_archive(
            &row,
            Some("me@company.com"),
            &["work@company.com".to_string()]
        ));
    }

    #[test]
    fn self_sent_forces_ignore_over_model_inform() {
        let candidate = InboxCandidate {
            message_id: "m1".into(),
            date: "2025-01-01".into(),
            from_address: "lewiscirne@gmail.com".into(),
            from_name: None,
            to_addresses: vec![],
            cc_addresses: vec![],
            subject: "Re: test".into(),
            snippet: "body".into(),
            category: None,
            attachments: vec![],
        };
        let row = to_preview_row(
            &candidate,
            InboxNotablePick {
                message_id: "m1".into(),
                action: Some("inform".into()),
                matched_rule_ids: vec![],
                note: Some("model liked it".into()),
                decision_source: Some("model".into()),
            },
            Some("lewiscirne@gmail.com"),
            &[],
        );
        assert_eq!(row.action.as_deref(), Some("ignore"));
        assert_eq!(row.decision_source.as_deref(), Some("heuristic"));
        assert!(
            row.note
                .as_deref()
                .is_some_and(|n| n.contains("sent from your address")),
            "{:?}",
            row.note
        );
    }

    #[test]
    fn parse_notable_invalid_json_fallback_prefers_inform_for_ambiguous_mail() {
        let batch = vec![InboxCandidate {
            message_id: "m1".into(),
            date: "2025-01-01".into(),
            from_address: "a@b.com".into(),
            from_name: None,
            to_addresses: vec![],
            cc_addresses: vec![],
            subject: "s".into(),
            snippet: "x".into(),
            category: None,
            attachments: vec![],
        }];
        let r = parse_notable_response("not json", &batch).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].action.as_deref(), Some("inform"));
        assert_eq!(r[0].decision_source.as_deref(), Some("fallback"));
        let n = r[0].note.as_deref().unwrap();
        assert!(n.contains("Heuristic:"), "{n}");
        assert!(n.contains("Fallback: model returned invalid JSON."), "{n}");
    }

    #[test]
    fn parse_notable_filters_unknown_ids() {
        let batch = vec![InboxCandidate {
            message_id: "m1".into(),
            date: "2025-01-01".into(),
            from_address: "a@b.com".into(),
            from_name: None,
            to_addresses: vec![],
            cc_addresses: vec![],
            subject: "s".into(),
            snippet: "x".into(),
            category: None,
            attachments: vec![],
        }];
        let j = r#"{"results":[{"messageId":"other","note":"n"},{"messageId":"m1","action":"notify","matchedRuleIds":[],"note":"  hi  "} ]}"#;
        let r = parse_notable_response(j, &batch).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].message_id, "m1");
        assert_eq!(r[0].note.as_deref(), Some("hi"));
        assert_eq!(r[0].action.as_deref(), Some("notify"));
        assert_eq!(r[0].decision_source.as_deref(), Some("model"));
    }

    #[test]
    fn parse_notable_missing_results_defaults_empty_batch() {
        let batch: Vec<InboxCandidate> = vec![];
        let r = parse_notable_response(r#"{"foo":[]}"#, &batch).unwrap();
        assert!(r.is_empty());
    }

    #[test]
    fn fallback_suppresses_list_mail() {
        let batch = vec![InboxCandidate {
            message_id: "m1".into(),
            date: "2025-01-01".into(),
            from_address: "notifications-noreply@linkedin.com".into(),
            from_name: None,
            to_addresses: vec![],
            cc_addresses: vec![],
            subject: "You have 1 new invitation".into(),
            snippet: "body".into(),
            category: Some("list".into()),
            attachments: vec![],
        }];
        let r = parse_notable_response("not json", &batch).unwrap();
        assert_eq!(r[0].action.as_deref(), Some("ignore"));
        let n = r[0].note.as_deref().unwrap();
        assert!(n.contains("list") || n.contains("excluded"), "{n}");
    }

    #[tokio::test]
    async fn preview_rule_impact_filters_to_new_rule_without_side_effects() {
        let conn = open_memory().unwrap();
        let matching = ParsedMessage {
            message_id: "m1".into(),
            from_address: "alice@example.com".into(),
            from_name: Some("Alice".into()),
            to_addresses: vec!["me@example.com".into()],
            cc_addresses: vec![],
            subject: "Quarterly budget".into(),
            date: "2026-03-31T09:00:00Z".into(),
            body_text: "Budget discussion for Q2".into(),
            body_html: None,
            attachments: vec![],
            category: None,
        };
        let other = ParsedMessage {
            message_id: "m2".into(),
            from_address: "bob@example.com".into(),
            from_name: Some("Bob".into()),
            to_addresses: vec!["me@example.com".into()],
            cc_addresses: vec![],
            subject: "Hello".into(),
            date: "2026-03-31T08:00:00Z".into(),
            body_text: "General update".into(),
            body_html: None,
            attachments: vec![],
            category: None,
        };
        persist_message(&conn, &matching, "INBOX", 1, "[]", "m1.eml").unwrap();
        persist_message(&conn, &other, "INBOX", 2, "[]", "m2.eml").unwrap();

        let mut classifier = MockInboxClassifier::new(|batch| {
            batch
                .into_iter()
                .map(|candidate| InboxNotablePick {
                    message_id: candidate.message_id.clone(),
                    action: Some(if candidate.message_id == "m1" {
                        "ignore".into()
                    } else {
                        "inform".into()
                    }),
                    matched_rule_ids: if candidate.message_id == "m1" {
                        vec!["r123".into()]
                    } else {
                        vec![]
                    },
                    note: Some(format!("classified {}", candidate.message_id)),
                    decision_source: Some(if candidate.message_id == "m1" {
                        "rule".into()
                    } else {
                        "model".into()
                    }),
                })
                .collect()
        });
        let preview = preview_rule_impact(
            &conn,
            &RunInboxScanOptions {
                surface_mode: InboxSurfaceMode::Review,
                cutoff_iso: "2026-03-01T00:00:00Z".into(),
                include_all: true,
                replay: true,
                reapply_llm: true,
                diagnostics: true,
                rules_fingerprint: None,
                owner_address: Some("me@example.com".into()),
                owner_aliases: vec![],
                candidate_cap: Some(10),
                notable_cap: None,
                batch_size: Some(10),
            },
            &mut classifier,
            "r123",
        )
        .await
        .unwrap();

        assert_eq!(preview.candidates_scanned, 2);
        assert_eq!(preview.matched.len(), 1);
        assert_eq!(preview.matched[0].message_id, "m1");
        assert_eq!(preview.matched[0].action.as_deref(), Some("ignore"));
        assert_eq!(
            preview.matched[0].matched_rule_ids,
            vec!["r123".to_string()]
        );

        let is_archived: i64 = conn
            .query_row(
                "SELECT is_archived FROM messages WHERE message_id = 'm1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(is_archived, 0);
    }
}
