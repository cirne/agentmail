//! Notable-mail LLM scan (`src/inbox/scan.ts`).

use std::collections::{HashMap, HashSet};
use std::time::Instant;

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
const DEFAULT_BATCH_SIZE: usize = 40;
const DEFAULT_INBOX_PREFETCH_CAP: usize = 200;

const NANO_MODEL: &str = "gpt-4.1-nano";

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

fn fallback_action(candidate: &InboxCandidate) -> &'static str {
    if candidate.category.as_deref().is_some_and(|category| {
        category == CATEGORY_LIST || is_default_excluded_category(Some(category))
    }) {
        return "suppress";
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

    if is_noreply(&from_address)
        || from_address.contains("newsletter")
        || from_address.contains("linkedin")
        || automated_subject
        || automated_snippet
    {
        return "archive";
    }

    "archive"
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
                    fallback_pick(
                        candidate,
                        "Included by fallback because the model returned invalid JSON.",
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
                    fallback_pick(
                        candidate,
                        "Included by fallback because the model omitted results.",
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
                    fallback_pick(
                    candidate,
                    "Included by fallback because the model returned a malformed results payload.",
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
        out.push(InboxNotablePick {
            message_id: candidate.message_id.clone(),
            action: Some(fallback_action(candidate).into()),
            matched_rule_ids: vec![],
            note: Some("Included by fallback because no explicit decision was returned.".into()),
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
        "suppress" => "suppress",
        "archive" => "archive",
        _ => "inform",
    }
}

fn surface_matches(mode: InboxSurfaceMode, action: &str) -> bool {
    match mode {
        InboxSurfaceMode::Check => action == "notify",
        InboxSurfaceMode::Review => matches!(action, "notify" | "inform"),
    }
}

fn to_preview_row(candidate: &InboxCandidate, pick: InboxNotablePick) -> RefreshPreviewRow {
    let attachments = if candidate.attachments.is_empty() {
        None
    } else {
        Some(list_to_preview_attachments(candidate.attachments.clone()))
    };
    let action = normalize_action(pick.action.as_deref()).to_string();
    RefreshPreviewRow {
        message_id: candidate.message_id.clone(),
        date: candidate.date.clone(),
        from_address: candidate.from_address.clone(),
        from_name: candidate.from_name.clone(),
        subject: candidate.subject.clone(),
        snippet: candidate.snippet.clone(),
        note: pick.note,
        attachments,
        category: candidate.category.clone(),
        action: Some(action),
        matched_rule_ids: pick.matched_rule_ids.clone(),
        decision_source: pick.decision_source,
    }
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

    let sql = format!(
        "SELECT message_id, from_address, from_name, to_addresses, cc_addresses, subject, date,
         COALESCE(TRIM(SUBSTR(body_text, 1, 200)), '') ||
         CASE WHEN LENGTH(TRIM(body_text)) > 200 THEN '…' ELSE '' END AS snippet,
         category
         FROM messages
         WHERE date >= ?1
           AND is_archived = 0
           AND NOT EXISTS (SELECT 1 FROM inbox_handled h WHERE h.message_id = messages.message_id)
           {category_sql}{surfaced_sql}
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
        rows.push(to_preview_row(candidate, pick));
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
    let (rows, llm_duration_ms) = classify_candidates(&candidates, batch_size, classifier).await?;
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

fn apply_decision_side_effects(conn: &Connection, row: &RefreshPreviewRow) -> rusqlite::Result<()> {
    if let Some("archive") = row.action.as_deref() {
        conn.execute(
            "UPDATE messages SET is_archived = 1 WHERE message_id = ?1",
            [&row.message_id],
        )?;
    }
    Ok(())
}

/// Run inbox notable scan (Node `runInboxScan`).
pub async fn run_inbox_scan(
    conn: &Connection,
    options: &RunInboxScanOptions,
    classifier: &mut dyn InboxBatchClassifier,
) -> Result<RunInboxScanResult, RunInboxScanError> {
    let candidate_cap = options.candidate_cap.unwrap_or(DEFAULT_CANDIDATE_CAP);
    let notable_cap = options.notable_cap.unwrap_or(DEFAULT_NOTABLE_CAP);
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
            );
            cached_by_id.insert(row.message_id.clone(), row);
        }
    }
    let llm_candidates: Vec<InboxCandidate> = candidates
        .iter()
        .filter(|candidate| !cached_by_id.contains_key(&candidate.message_id))
        .cloned()
        .collect();

    let (fresh_rows, llm_duration_ms) =
        classify_candidates(&llm_candidates, batch_size, classifier).await?;

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
        apply_decision_side_effects(conn, &row)?;
        match row.action.as_deref().unwrap_or("inform") {
            "notify" => counts.notify += 1,
            "inform" => counts.inform += 1,
            "archive" => counts.archive += 1,
            "suppress" => counts.suppress += 1,
            _ => {}
        }
        if row
            .action
            .as_deref()
            .is_some_and(|action| surface_matches(options.surface_mode, action))
        {
            surfaced.push(row.clone());
        }
        processed.push(row);
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

    #[test]
    fn parse_notable_invalid_json_defaults_to_inform() {
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
        assert_eq!(r[0].action.as_deref(), Some("archive"));
        assert_eq!(r[0].decision_source.as_deref(), Some("fallback"));
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
        assert_eq!(r[0].action.as_deref(), Some("suppress"));
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
                        "archive".into()
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
        assert_eq!(preview.matched[0].action.as_deref(), Some("archive"));
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
