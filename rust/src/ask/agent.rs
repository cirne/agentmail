//! `run_ask` — Nano investigation loop, context assembly, Mini synthesis ([`src/ask/agent.ts`](../../../src/ask/agent.ts)).

use std::collections::HashSet;
use std::io::Write;
use std::path::Path;

use async_openai::config::OpenAIConfig;
use async_openai::types::{
    ChatCompletionRequestAssistantMessage, ChatCompletionRequestAssistantMessageContent,
    ChatCompletionRequestMessage, ChatCompletionRequestSystemMessage,
    ChatCompletionRequestSystemMessageContent, ChatCompletionRequestToolMessage,
    ChatCompletionRequestToolMessageContent, ChatCompletionRequestUserMessage,
    ChatCompletionRequestUserMessageContent, ChatCompletionResponseMessage,
    ChatCompletionToolChoiceOption, CreateChatCompletionRequestArgs, CreateChatCompletionResponse,
};
use async_openai::Client;
use chrono::Datelike;
use futures::StreamExt;
use rusqlite::Connection;
use serde_json::{json, Value};

use super::context::assemble_context;
use super::openai_tools::investigation_tool_definitions;
use super::tools::execute_nano_tool;
use crate::ask_stub::{ask_rejects_old_explicit_year, ask_rejects_stale_date_range};

const NANO_MODEL: &str = "gpt-4.1-nano";
const MINI_MODEL: &str = "gpt-4.1-mini";
const MAX_TRIES: i32 = 5;

/// CLI options for `zmail ask`.
#[derive(Debug, Clone, Default)]
pub struct RunAskOptions {
    pub stream: bool,
    pub verbose: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum RunAskError {
    #[error("SQLite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("OpenAI: {0}")]
    OpenAI(#[from] async_openai::error::OpenAIError),
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Message(String),
}

fn vlog(verbose: bool, msg: &str) {
    if verbose {
        eprintln!(
            "{}",
            if msg.ends_with('\n') {
                msg.trim_end().to_string()
            } else {
                msg.to_string()
            }
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn investigation_system_prompt(
    current_date_str: &str,
    weekday_long: &str,
    month_long: &str,
    day: u32,
    year: i32,
    current_month: u32,
    current_year: i32,
    last_month: u32,
    last_month_year: i32,
    last_day_of_last_month: u32,
) -> String {
    format!(
        "TODAY'S DATE: {current_date_str} ({weekday_long}, {month_long} {day}, {year}).\n\
         CURRENT YEAR: {current_year}. CURRENT MONTH: {current_month}.\n\
         When the user says \"last month\", that means {last_month_year}-{last_month:02}-01 to {last_month_year}-{last_month:02}-{last_day_of_last_month}.\n\
         IMPORTANT: Always use {current_year} as the current year when interpreting dates. Do NOT use 2024 or other years unless explicitly specified by the user.\n\n\
         You are an email investigator. Search and explore to find messages (and attachments) that answer the user's question. Results are metadata only (subject, from, date, snippet); use get_message to read full bodies. When done, say \"investigation complete\".\n\n\
         HOW TO SEARCH — two patterns:\n\n\
         1) ALL from a sender or domain (spending, receipts, compliance, \"everything from X\"):\n\
            Call search with the fromAddress PARAMETER set to the domain or address — e.g. fromAddress: \"apple.com\" or fromAddress: \"noreply@apple.com\". Do NOT put fromAddress or the domain in the query string. Optionally add query for topic (e.g. query: \"receipt OR order\") and use afterDate/beforeDate if the question mentions a time range. Promotional mail is excluded by default, so you get the full transactional set; default limit is usually enough.\n\n\
         2) FIND relevant messages about a topic (\"what did Dan suggest\", \"invoices\", \"meeting with Y\"):\n\
            Call search with the topic in the query parameter. Use 2–3 key terms; use OR (uppercase) for alternatives. FTS treats spaces as AND, so avoid long phrases. Examples: \"dan cabo\" OR \"cabo\"; \"invoice OR receipt\"; \"funds request\". Omit fromAddress unless the user clearly means \"from that sender only\". Use limit 50–100+ for broad topics. If 0 results, try fewer or simpler terms.\n\n\
         When to omit query: Only when the user asks for recent/latest messages with no specific topic (e.g. \"my 5 most recent emails\") — then use afterDate + limit and no query. For any topic (invoices, a person, a company), always include a query.\n\n\
         Dates: Use afterDate/beforeDate only when the question mentions a time period. Use relative values (e.g. 30d, 7d, 1w) or the current year — never hardcoded old years like 2023. Interpret \"last month\" from the current date above.\n\n\
         Pay attention to result hints (e.g. totalMatched, \"most results from X\") and to attachment metadata so context assembly includes the right messages."
    )
}

fn response_to_assistant_request(
    msg: &ChatCompletionResponseMessage,
) -> ChatCompletionRequestAssistantMessage {
    ChatCompletionRequestAssistantMessage {
        content: msg
            .content
            .as_ref()
            .map(|s| ChatCompletionRequestAssistantMessageContent::Text(s.clone())),
        refusal: msg.refusal.clone(),
        tool_calls: msg.tool_calls.clone(),
        ..Default::default()
    }
}

fn assistant_text(msg: &ChatCompletionResponseMessage) -> String {
    msg.content.clone().unwrap_or_default()
}

fn collect_candidates_from_parsed(
    parsed: &Value,
    candidate_message_ids: &mut HashSet<String>,
    candidate_attachment_ids: &mut HashSet<i64>,
) -> (usize, usize) {
    let before = candidate_message_ids.len();
    let mut result_count = 0;

    if let Some(arr) = parsed.get("results").and_then(|x| x.as_array()) {
        result_count = arr.len();
        for r in arr {
            if let Some(mid) = r.get("messageId").and_then(|x| x.as_str()) {
                candidate_message_ids.insert(mid.to_string());
            }
            if let Some(atts) = r.get("attachments").and_then(|x| x.as_array()) {
                for att in atts {
                    if let Some(id) = att.get("id").and_then(|x| x.as_i64()) {
                        candidate_attachment_ids.insert(id);
                    }
                }
            }
        }
    } else if let Some(mid) = parsed.get("messageId").and_then(|x| x.as_str()) {
        result_count = 1;
        candidate_message_ids.insert(mid.to_string());
        if let Some(atts) = parsed.get("attachments").and_then(|x| x.as_array()) {
            for att in atts {
                if let Some(id) = att.get("id").and_then(|x| x.as_i64()) {
                    candidate_attachment_ids.insert(id);
                }
            }
        }
    }

    let new_messages = candidate_message_ids.len().saturating_sub(before);
    (result_count, new_messages)
}

fn sanitize_search_args(
    question: &str,
    current_year: i32,
    args: &mut serde_json::Map<String, Value>,
) {
    let q_lower = question.to_lowercase();
    let asks_for_all = q_lower.contains("any ")
        || q_lower.contains("all ")
        || q_lower.contains("ever")
        || q_lower.contains("everything")
        || regex::Regex::new(r"\bany\b")
            .ok()
            .map(|r| r.is_match(&q_lower))
            .unwrap_or(false)
        || regex::Regex::new(r"\ball\b")
            .ok()
            .map(|r| r.is_match(&q_lower))
            .unwrap_or(false);

    if let Some(Value::String(ref after)) = args.get("afterDate").cloned() {
        if regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$")
            .ok()
            .map(|r| r.is_match(after))
            .unwrap_or(false)
        {
            if let Ok(y) = after[0..4].parse::<i32>() {
                if y < current_year - 1 && !q_lower.contains(&y.to_string()) {
                    args.remove("afterDate");
                }
            }
        }
    }

    if asks_for_all {
        args.remove("afterDate");
        args.remove("beforeDate");
    }
}

/// Run the ask pipeline (async; call from CLI via `tokio::runtime::Runtime::block_on`).
pub async fn run_ask(
    question: &str,
    conn: &Connection,
    data_dir: &Path,
    imap_user: &str,
    cache_attachments: bool,
    api_key: &str,
    opts: RunAskOptions,
) -> Result<(), RunAskError> {
    ask_rejects_stale_date_range(question).map_err(RunAskError::Message)?;
    ask_rejects_old_explicit_year(question).map_err(RunAskError::Message)?;

    let start = std::time::Instant::now();
    let v = opts.verbose;

    let config = OpenAIConfig::new().with_api_key(api_key);
    let client = Client::with_config(config);

    let now = chrono::Utc::now();
    let current_year = now.year();
    let current_month = now.month();
    let day = now.day();
    let current_date_str = format!("{current_year}-{current_month:02}-{day:02}");
    let weekday_long = now.format("%A").to_string();
    let month_long = now.format("%B").to_string();
    let last_month = if current_month == 1 {
        12
    } else {
        current_month - 1
    };
    let last_month_year = if current_month == 1 {
        current_year - 1
    } else {
        current_year
    };
    let last_day_of_last_month =
        chrono::NaiveDate::from_ymd_opt(last_month_year, last_month + 1, 1)
            .and_then(|d| d.pred_opt())
            .map(|d| d.day())
            .unwrap_or(28);

    let sys = investigation_system_prompt(
        &current_date_str,
        &weekday_long,
        &month_long,
        day,
        current_year,
        current_month,
        current_year,
        last_month,
        last_month_year,
        last_day_of_last_month,
    );

    let mut investigation_messages: Vec<ChatCompletionRequestMessage> = vec![
        ChatCompletionRequestMessage::System(ChatCompletionRequestSystemMessage {
            content: ChatCompletionRequestSystemMessageContent::Text(sys),
            name: None,
        }),
        ChatCompletionRequestMessage::User(ChatCompletionRequestUserMessage {
            content: ChatCompletionRequestUserMessageContent::Text(question.to_string()),
            name: None,
        }),
    ];

    let tools = investigation_tool_definitions();
    let mut candidate_message_ids: HashSet<String> = HashSet::new();
    let mut candidate_attachment_ids: HashSet<i64> = HashSet::new();
    let mut search_history: Vec<serde_json::Map<String, Value>> = Vec::new();
    let mut consecutive_filtered_failures = 0i32;
    let mut investigation_attempt_count = 0i32;
    let owner = imap_user.trim();
    let owner_opt = if owner.is_empty() { None } else { Some(owner) };

    vlog(
        v,
        "[phase 1] investigation: searching for relevant messages\n",
    );

    while investigation_attempt_count < MAX_TRIES {
        let req = CreateChatCompletionRequestArgs::default()
            .model(NANO_MODEL)
            .messages(investigation_messages.clone())
            .tools(tools.clone())
            .tool_choice(ChatCompletionToolChoiceOption::Auto)
            .build()?;

        let response: CreateChatCompletionResponse = client.chat().create(req).await?;
        let choice = response
            .choices
            .into_iter()
            .next()
            .ok_or_else(|| RunAskError::Message("No response from nano".into()))?;
        let message = choice.message;

        investigation_messages.push(ChatCompletionRequestMessage::Assistant(
            response_to_assistant_request(&message),
        ));

        let has_tool_calls = message
            .tool_calls
            .as_ref()
            .map(|t| !t.is_empty())
            .unwrap_or(false);

        if has_tool_calls {
            let tool_calls = message.tool_calls.as_ref().unwrap();
            investigation_attempt_count += 1;
            vlog(
                v,
                &format!(
                    "[phase 1 investigation {investigation_attempt_count}/{MAX_TRIES}] tool calls: {}",
                    tool_calls.len()
                ),
            );

            for tool_call in tool_calls {
                if tool_call.r#type != async_openai::types::ChatCompletionToolType::Function {
                    continue;
                }
                let tool_name = tool_call.function.name.as_str();
                let mut tool_args: serde_json::Map<String, Value> =
                    serde_json::from_str(&tool_call.function.arguments).unwrap_or_default();

                if tool_name == "search" {
                    sanitize_search_args(question, current_year, &mut tool_args);
                    search_history.push(tool_args.clone());
                }

                let has_from = tool_name == "search"
                    && tool_args
                        .get("fromAddress")
                        .and_then(|x| x.as_str())
                        .map(|s| !s.trim().is_empty())
                        .unwrap_or(false);
                let has_to = tool_name == "search"
                    && tool_args
                        .get("toAddress")
                        .and_then(|x| x.as_str())
                        .map(|s| !s.trim().is_empty())
                        .unwrap_or(false);

                vlog(
                    v,
                    &format!(
                        "[phase 1] calling {tool_name}({})",
                        Value::Object(tool_args.clone())
                    ),
                );

                let result = execute_nano_tool(conn, data_dir, owner_opt, tool_name, &tool_args)?;

                if tool_name == "search" || tool_name == "get_message" {
                    let parsed: Value = serde_json::from_str(&result)?;
                    let (result_count, _) = collect_candidates_from_parsed(
                        &parsed,
                        &mut candidate_message_ids,
                        &mut candidate_attachment_ids,
                    );

                    if tool_name == "search" {
                        vlog(
                                v,
                                &format!(
                                    "[phase 1] search returned {result_count} results, total: {} messages, {} attachments",
                                    candidate_message_ids.len(),
                                    candidate_attachment_ids.len()
                                ),
                            );

                        if result_count == 0 && (has_from || has_to) {
                            consecutive_filtered_failures += 1;
                            if consecutive_filtered_failures >= 2
                                && investigation_attempt_count < MAX_TRIES - 1
                            {
                                investigation_messages.push(ChatCompletionRequestMessage::Tool(
                                    ChatCompletionRequestToolMessage {
                                        content: ChatCompletionRequestToolMessageContent::Text(
                                            result.clone(),
                                        ),
                                        tool_call_id: tool_call.id.clone(),
                                    },
                                ));
                                investigation_messages.push(ChatCompletionRequestMessage::User(
                                        ChatCompletionRequestUserMessage {
                                            content: ChatCompletionRequestUserMessageContent::Text(
                                                format!("You've tried {consecutive_filtered_failures} filtered searches and got 0 results. IMMEDIATELY try the same queries WITHOUT fromAddress/toAddress filters. For example, if you searched \"dan suggest cabo\" with filters, try \"dan cabo\" without any filters. Also try just \"cabo\" alone."),
                                            ),
                                            name: None,
                                        },
                                    ));
                                consecutive_filtered_failures = 0;
                                continue;
                            }
                        } else if result_count > 0 {
                            consecutive_filtered_failures = 0;
                        }
                    }
                }

                investigation_messages.push(ChatCompletionRequestMessage::Tool(
                    ChatCompletionRequestToolMessage {
                        content: ChatCompletionRequestToolMessageContent::Text(result),
                        tool_call_id: tool_call.id.clone(),
                    },
                ));
            }
            continue;
        }

        {
            let final_content = assistant_text(&message);
            vlog(
                v,
                &format!(
                    "[phase 1] final message: {}...",
                    final_content.chars().take(200).collect::<String>()
                ),
            );
            let content_lower = final_content.to_lowercase();
            if content_lower.contains("investigation complete")
                || content_lower.contains("ready for context assembly")
                || content_lower.contains("ready to assemble")
                || !candidate_message_ids.is_empty()
            {
                vlog(
                    v,
                    &format!(
                        "[phase 1] investigation complete. Found {} candidate messages, {} candidate attachments",
                        candidate_message_ids.len(),
                        candidate_attachment_ids.len()
                    ),
                );
                break;
            }

            if candidate_message_ids.is_empty() && investigation_attempt_count < MAX_TRIES - 1 {
                investigation_attempt_count += 1;
                vlog(
                    v,
                    &format!(
                        "[phase 1] no candidates found yet, prompting broader searches (attempt {investigation_attempt_count}/{MAX_TRIES})"
                    ),
                );
                let question_lower = question.to_lowercase();
                let mut guidance =
                    "You haven't found any candidate messages yet. Try these searches:\n"
                        .to_string();
                guidance.push_str("1. Remove ALL filters (no fromAddress/toAddress) and search with just the person's name + topic\n");
                if question_lower.contains("dan") && question_lower.contains("cabo") {
                    guidance.push_str("2. Try: 'dan cabo' (without filters)\n");
                    guidance.push_str("3. Try: 'cabo' (without filters)\n");
                } else {
                    guidance.push_str("2. Try: person name + topic (e.g., if question is 'what did X suggest about Y?', try 'X Y')\n");
                    guidance.push_str("3. Try: just the topic alone\n");
                }
                guidance.push_str("Don't give up - filtered searches often fail, but broader searches usually work.");
                investigation_messages.push(ChatCompletionRequestMessage::User(
                    ChatCompletionRequestUserMessage {
                        content: ChatCompletionRequestUserMessageContent::Text(guidance),
                        name: None,
                    },
                ));
                continue;
            }

            investigation_attempt_count += 1;
            if investigation_attempt_count >= MAX_TRIES {
                vlog(
                    v,
                    &format!(
                        "[phase 1] reached max attempts, moving to context assembly with {} candidates",
                        candidate_message_ids.len()
                    ),
                );
                break;
            }
        }
    }

    if candidate_message_ids.is_empty() && !search_history.is_empty() {
        vlog(
            v,
            &format!(
                "[phase 1 retry] no candidates found, retrying {} searches with includeNoise=true",
                search_history.len()
            ),
        );
        for mut args in search_history.clone() {
            args.insert("includeNoise".into(), json!(true));
            let result = execute_nano_tool(conn, data_dir, owner_opt, "search", &args)?;
            if let Ok(parsed) = serde_json::from_str::<Value>(&result) {
                collect_candidates_from_parsed(
                    &parsed,
                    &mut candidate_message_ids,
                    &mut candidate_attachment_ids,
                );
            }
        }
    }

    let message_ids_to_fetch: Vec<String> = candidate_message_ids.iter().cloned().collect();
    vlog(
        v,
        &format!(
            "[context assembly] using {} candidate messages, {} candidate attachments",
            message_ids_to_fetch.len(),
            candidate_attachment_ids.len()
        ),
    );

    if message_ids_to_fetch.is_empty() {
        vlog(v, "[context assembly] WARNING: no candidate messages found. This may result in an incomplete answer.\n");
    }

    let context = assemble_context(
        conn,
        data_dir,
        &message_ids_to_fetch,
        &candidate_attachment_ids,
        question,
        cache_attachments,
        v,
    )?;

    vlog(
        v,
        &format!(
            "[context] assembled {} chars from {} messageIds, {} attachments",
            context.len(),
            message_ids_to_fetch.len(),
            candidate_attachment_ids.len()
        ),
    );

    if context.is_empty() {
        vlog(v, "[context] WARNING: empty context - no emails fetched\n");
    }

    let mini_messages: Vec<ChatCompletionRequestMessage> = vec![
        ChatCompletionRequestMessage::System(ChatCompletionRequestSystemMessage {
            content: ChatCompletionRequestSystemMessageContent::Text(
                "You are an email assistant. Answer the user's question using only the provided email context. \
                 Match your response length and detail to the complexity of the question. \
                 For simple factual queries, be concise. \
                 For broad synthesis across many emails, be thorough — surface specific details (dates, locations, names, amounts), \
                 call out changes between drafts or revisions, and distinguish current state from superseded or cancelled plans. \
                 Use structured formatting (sections, bullets, timeline) when synthesizing across many emails. \
                 Cite subject or sender when relevant. If you cannot find enough information in the context, say so."
                    .into(),
            ),
            name: None,
        }),
        ChatCompletionRequestMessage::User(ChatCompletionRequestUserMessage {
            content: ChatCompletionRequestUserMessageContent::Text(format!(
                "{question}\n\n--- Email Context ---\n{context}"
            )),
            name: None,
        }),
    ];

    if opts.stream {
        let req = CreateChatCompletionRequestArgs::default()
            .model(MINI_MODEL)
            .messages(mini_messages)
            .build()?;
        let mut stream = client.chat().create_stream(req).await?;
        while let Some(item) = stream.next().await {
            let item = item?;
            for choice in item.choices {
                if let Some(delta) = choice.delta.content {
                    print!("{}", delta);
                    std::io::stdout().flush()?;
                }
            }
        }
        println!();
        let pipeline_ms = start.elapsed().as_millis();
        vlog(v, &format!("\npipelineMs: {pipeline_ms}\n"));
    } else {
        let req = CreateChatCompletionRequestArgs::default()
            .model(MINI_MODEL)
            .messages(mini_messages)
            .build()?;
        let response = client.chat().create(req).await?;
        let text = response
            .choices
            .first()
            .and_then(|c| c.message.content.clone())
            .unwrap_or_default();
        println!("{}", text);
        let pipeline_ms = start.elapsed().as_millis();
        vlog(v, &format!("\npipelineMs: {pipeline_ms}\n"));
    }

    Ok(())
}
