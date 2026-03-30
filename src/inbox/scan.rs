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
use crate::refresh::{RefreshPreviewAttachment, RefreshPreviewRow};
use crate::search::sort_rows_by_sender_contact_rank;

const DEFAULT_CANDIDATE_CAP: usize = 80;
const DEFAULT_NOTABLE_CAP: usize = 10;
const DEFAULT_BATCH_SIZE: usize = 40;
const DEFAULT_INBOX_PREFETCH_CAP: usize = 200;

const NANO_MODEL: &str = "gpt-4.1-nano";

const SYSTEM_PROMPT: &str = r#"You filter email metadata for a busy user. Return strict JSON only:
{"notable":[{"messageId":"<exact id from input>","note":"<one short line why this matters>"}]}

Include only messages that likely need human attention: personal mail, work decisions, security alerts, bills or invoices needing action, deadlines, direct questions to the user.

Exclude: marketing, newsletters, routine noreply/automated mail, social digests, generic "your order shipped" unless time-sensitive, obvious spam patterns.

If nothing qualifies, return {"notable":[]}. Every messageId in notable MUST appear exactly in the user JSON array."#;

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
    pub subject: String,
    pub snippet: String,
    pub attachments: Vec<AttachmentListRow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxNotablePick {
    pub message_id: String,
    pub note: Option<String>,
}

#[derive(Debug)]
pub struct RunInboxScanResult {
    pub new_mail: Vec<RefreshPreviewRow>,
    pub candidates_scanned: usize,
    pub llm_duration_ms: u64,
}

#[derive(Debug, Clone, Default)]
pub struct RunInboxScanOptions {
    pub cutoff_iso: String,
    pub include_noise: bool,
    pub owner_address: Option<String>,
    pub candidate_cap: Option<usize>,
    pub notable_cap: Option<usize>,
    pub batch_size: Option<usize>,
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
}

impl OpenAiInboxClassifier {
    pub fn new(api_key: &str) -> Self {
        let config = OpenAIConfig::new().with_api_key(api_key);
        Self {
            client: OpenAiClient::with_config(config),
        }
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
                o.insert("from".into(), json!(from_line));
                o.insert("subject".into(), json!(c.subject));
                o.insert(
                    "snippet".into(),
                    json!(c.snippet.chars().take(400).collect::<String>()),
                );
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
                        SYSTEM_PROMPT.to_string(),
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

fn parse_notable_response(
    text: &str,
    batch: &[InboxCandidate],
) -> Result<Vec<InboxNotablePick>, RunInboxScanError> {
    let allowed: HashSet<&str> = batch.iter().map(|b| b.message_id.as_str()).collect();
    let parsed: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()),
    };
    let notable = match parsed.get("notable") {
        Some(n) => n,
        None => return Ok(Vec::new()),
    };
    let arr = match notable.as_array() {
        Some(a) => a,
        None => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    for item in arr {
        let mid = item.get("messageId").and_then(|x| x.as_str());
        let Some(mid) = mid else { continue };
        if !allowed.contains(mid) {
            continue;
        }
        let note = item
            .get("note")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        out.push(InboxNotablePick {
            message_id: mid.to_string(),
            note,
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

/// Run inbox notable scan (Node `runInboxScan`).
pub async fn run_inbox_scan(
    conn: &Connection,
    options: &RunInboxScanOptions,
    classifier: &mut dyn InboxBatchClassifier,
) -> Result<RunInboxScanResult, RunInboxScanError> {
    let candidate_cap = options.candidate_cap.unwrap_or(DEFAULT_CANDIDATE_CAP);
    let notable_cap = options.notable_cap.unwrap_or(DEFAULT_NOTABLE_CAP);
    let batch_size = options.batch_size.unwrap_or(DEFAULT_BATCH_SIZE);
    let noise_sql = if options.include_noise {
        ""
    } else {
        " AND is_noise = 0"
    };
    let fetch_limit = inbox_candidate_prefetch_limit(candidate_cap);

    let sql = format!(
        "SELECT message_id, from_address, from_name, subject, date,
         COALESCE(TRIM(SUBSTR(body_text, 1, 200)), '') ||
         CASE WHEN LENGTH(TRIM(body_text)) > 200 THEN '…' ELSE '' END AS snippet
         FROM messages
         WHERE date >= ?1{noise_sql}
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
            ))
        },
    )?;

    let mut candidates: Vec<InboxCandidate> = Vec::new();
    for r in rows {
        let (message_id, from_address, from_name, subject, date, snippet) = r?;
        let attachments = list_attachments_for_message(conn, &message_id)?;
        candidates.push(InboxCandidate {
            message_id,
            date,
            from_address,
            from_name,
            subject,
            snippet: strip_snippet_html(&snippet),
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
            if merged.len() >= notable_cap {
                break;
            }
        }
        if merged.len() >= notable_cap {
            break;
        }
    }

    merged.truncate(notable_cap);

    let mut new_mail: Vec<RefreshPreviewRow> = Vec::new();
    for p in merged {
        let Some(c) = by_id.get(&p.message_id) else {
            continue;
        };
        let attachments = if c.attachments.is_empty() {
            None
        } else {
            Some(list_to_preview_attachments(c.attachments.clone()))
        };
        new_mail.push(RefreshPreviewRow {
            message_id: c.message_id.clone(),
            date: c.date.clone(),
            from_address: c.from_address.clone(),
            from_name: c.from_name.clone(),
            subject: c.subject.clone(),
            snippet: c.snippet.clone(),
            note: p.note,
            attachments,
        });
    }

    Ok(RunInboxScanResult {
        new_mail,
        candidates_scanned: candidates.len(),
        llm_duration_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefetch_limit_80_to_160() {
        assert_eq!(inbox_candidate_prefetch_limit(80), 160);
    }

    #[test]
    fn prefetch_limit_caps_200() {
        assert_eq!(inbox_candidate_prefetch_limit(150), 200);
    }

    #[test]
    fn parse_notable_invalid_json_empty() {
        let batch = vec![InboxCandidate {
            message_id: "m1".into(),
            date: "2025-01-01".into(),
            from_address: "a@b.com".into(),
            from_name: None,
            subject: "s".into(),
            snippet: "x".into(),
            attachments: vec![],
        }];
        let r = parse_notable_response("not json", &batch).unwrap();
        assert!(r.is_empty());
    }

    #[test]
    fn parse_notable_filters_unknown_ids() {
        let batch = vec![InboxCandidate {
            message_id: "m1".into(),
            date: "2025-01-01".into(),
            from_address: "a@b.com".into(),
            from_name: None,
            subject: "s".into(),
            snippet: "x".into(),
            attachments: vec![],
        }];
        let j =
            r#"{"notable":[{"messageId":"other","note":"n"},{"messageId":"m1","note":"  hi  "}]}"#;
        let r = parse_notable_response(j, &batch).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].message_id, "m1");
        assert_eq!(r[0].note.as_deref(), Some("hi"));
    }

    #[test]
    fn parse_notable_missing_notable_array() {
        let batch: Vec<InboxCandidate> = vec![];
        let r = parse_notable_response(r#"{"foo":[]}"#, &batch).unwrap();
        assert!(r.is_empty());
    }
}
