//! OpenAI `ChatCompletionTool` definitions for the investigation phase (Node `getInvestigationToolDefinitions`).

use async_openai::types::{ChatCompletionTool, ChatCompletionToolType, FunctionObject};
use serde_json::json;

/// Three tools: `search`, `get_thread_headers`, `get_message`.
pub fn investigation_tool_definitions() -> Vec<ChatCompletionTool> {
    let search_params = json!({
        "type": "object",
        "properties": {
            "query": { "type": "string", "description": "Full-text search query. Construct FTS5 queries using OR for alternatives." },
            "limit": { "type": "number", "description": "Maximum number of results (default: 50)." },
            "fromAddress": { "type": "string", "description": "Filter by sender email or domain (substring match)." },
            "toAddress": { "type": "string", "description": "Filter by recipient email address" },
            "subject": { "type": "string", "description": "Filter by subject" },
            "afterDate": { "type": "string", "description": "Filter messages after this date (relative e.g. 30d or ISO)" },
            "beforeDate": { "type": "string", "description": "Filter messages before this date" },
            "includeThreads": { "type": "boolean", "description": "When true, also return full threads (headers only)" },
            "filterOr": { "type": "boolean", "description": "OR logic between filters" },
            "includeAll": { "type": "boolean", "description": "Include all categories, including promotional, social, and automated mail" },
            "category": { "type": "string", "description": "Comma-separated categories to search within" }
        },
        "required": []
    });

    vec![
        ChatCompletionTool {
            r#type: ChatCompletionToolType::Function,
            function: FunctionObject {
                name: "search".into(),
                description: Some(
                    "Search emails by full-text and filters. Returns message list with headers/metadata only (messageId, threadId, from, subject, date, short snippet). No body content."
                        .into(),
                ),
                parameters: Some(search_params),
                strict: None,
            },
        },
        ChatCompletionTool {
            r#type: ChatCompletionToolType::Function,
            function: FunctionObject {
                name: "get_thread_headers".into(),
                description: Some(
                    "Get message headers in a thread by thread ID. Returns list of messages with messageId, from, subject, date only (no bodies)."
                        .into(),
                ),
                parameters: Some(json!({
                    "type": "object",
                    "properties": {
                        "threadId": { "type": "string", "description": "Thread ID (from search results)" }
                    },
                    "required": ["threadId"]
                })),
                strict: None,
            },
        },
        ChatCompletionTool {
            r#type: ChatCompletionToolType::Function,
            function: FunctionObject {
                name: "get_message".into(),
                description: Some(
                    "Get full message content by message ID. Returns full message with body content (up to maxBodyChars)."
                        .into(),
                ),
                parameters: Some(json!({
                    "type": "object",
                    "properties": {
                        "messageId": { "type": "string", "description": "Message ID (from search results)" },
                        "detail": { "type": "string", "enum": ["full", "summary", "raw"] },
                        "maxBodyChars": { "type": "number", "description": "Max body chars when detail='full'" },
                        "raw": { "type": "boolean" }
                    },
                    "required": ["messageId"]
                })),
                strict: None,
            },
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn investigation_tool_definitions_has_three_tools() {
        let t = investigation_tool_definitions();
        assert_eq!(t.len(), 3);
        assert_eq!(t[0].function.name, "search");
        assert_eq!(t[1].function.name, "get_thread_headers");
        assert_eq!(t[2].function.name, "get_message");
    }
}
