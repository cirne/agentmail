//! LLM compose for drafts (`compose-new-draft.ts`, `draft-rewrite.ts`).

use async_openai::config::OpenAIConfig;
use async_openai::types::{
    ChatCompletionRequestMessage, ChatCompletionRequestSystemMessage,
    ChatCompletionRequestSystemMessageContent, ChatCompletionRequestUserMessage,
    ChatCompletionRequestUserMessageContent, CreateChatCompletionRequestArgs, ResponseFormat,
};
use async_openai::Client;

use super::draft_store::DraftFile;

const MODEL: &str = "gpt-4.1-mini";

const COMPOSE_SYSTEM: &str = r#"You compose a new email from the user's instruction.

Return a single JSON object with exactly these keys:
- "subject" (string): a concise email subject line.
- "body" (string): the full message body. The user may want Markdown (headings, lists, emphasis); use it when it helps readability unless the instruction asks for plain text only.

Follow the instruction for tone, content, and length. Do not include a "Subject:" line inside the body."#;

const REWRITE_SYSTEM: &str = r#"You revise an email draft based on the user's instruction.

Return a single JSON object with exactly these keys:
- "body" (string): the full revised message body only. No "Subject:" line inside the body. The user may use Markdown; preserve that style when appropriate unless the instruction asks otherwise.
- "subject" (string or null): a new subject line ONLY if the instruction clearly requires changing the subject; otherwise null.

Apply the instruction faithfully (remove sections, change tone, fix typos, shorten, etc.). Preserve parts the instruction does not ask to change. If something is ambiguous, prefer minimal edits."#;

async fn chat_json_object(api_key: &str, system: &str, user_json: &str) -> Result<String, String> {
    let c = Client::with_config(OpenAIConfig::new().with_api_key(api_key));
    let req = CreateChatCompletionRequestArgs::default()
        .model(MODEL)
        .messages(vec![
            ChatCompletionRequestMessage::System(ChatCompletionRequestSystemMessage {
                content: ChatCompletionRequestSystemMessageContent::Text(system.to_string()),
                name: None,
            }),
            ChatCompletionRequestMessage::User(ChatCompletionRequestUserMessage {
                content: ChatCompletionRequestUserMessageContent::Text(user_json.to_string()),
                name: None,
            }),
        ])
        .response_format(ResponseFormat::JsonObject)
        .build()
        .map_err(|e| e.to_string())?;
    let resp = c.chat().create(req).await.map_err(|e| e.to_string())?;
    let content = resp
        .choices
        .first()
        .and_then(|c| c.message.content.as_ref())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "empty model response".to_string())?;
    Ok(content)
}

/// Subject and body for a new draft from natural-language instruction.
pub async fn compose_new_draft_from_instruction(
    to: Vec<String>,
    instruction: &str,
    api_key: &str,
) -> Result<(String, String), String> {
    let instruction = instruction.trim();
    if instruction.is_empty() {
        return Err("Compose instruction is empty".into());
    }
    if to.is_empty() {
        return Err("At least one recipient (to) is required".into());
    }
    let user = serde_json::json!({ "instruction": instruction, "to": to }).to_string();
    let raw = chat_json_object(api_key, COMPOSE_SYSTEM, &user).await?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "Model returned invalid JSON".to_string())?;
    let subj = v
        .get("subject")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            r#"Model response must include a non-empty string "subject" field"#.to_string()
        })?;
    let body = v
        .get("body")
        .and_then(|x| x.as_str())
        .ok_or_else(|| r#"Model response must include a string "body" field"#.to_string())?;
    Ok((subj.to_string(), body.to_string()))
}

pub struct RewriteDraftResult {
    pub body: String,
    pub subject: Option<String>,
}

/// Rewrite draft body (and optionally subject) from natural-language instruction.
pub async fn rewrite_draft_with_instruction(
    draft: &DraftFile,
    instruction: &str,
    api_key: &str,
) -> Result<RewriteDraftResult, String> {
    let instruction = instruction.trim();
    if instruction.is_empty() {
        return Err("Rewrite instruction is empty".into());
    }
    let fm = &draft.meta;
    let user = serde_json::json!({
        "instruction": instruction,
        "draftKind": fm.kind.as_deref().unwrap_or("new"),
        "recipients": {
            "to": fm.to.clone().unwrap_or_default(),
            "cc": fm.cc.clone().unwrap_or_default(),
            "bcc": fm.bcc.clone().unwrap_or_default(),
        },
        "currentSubject": fm.subject.as_deref().unwrap_or(""),
        "currentBody": draft.body,
    })
    .to_string();
    let raw = chat_json_object(api_key, REWRITE_SYSTEM, &user).await?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "Model returned invalid JSON".to_string())?;
    let body = v
        .get("body")
        .and_then(|x| x.as_str())
        .ok_or_else(|| r#"Model response must include a string "body" field"#.to_string())?
        .to_string();
    let subject = v.get("subject").and_then(|x| {
        if x.is_null() {
            None
        } else {
            x.as_str()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        }
    });
    Ok(RewriteDraftResult { body, subject })
}
