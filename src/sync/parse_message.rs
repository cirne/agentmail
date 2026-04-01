//! MIME parse → structured message (mirrors `src/sync/parse-message.ts`).

use mail_parser::{Address, Message, MessageParser, MimeHeaders, PartType};
use serde::Serialize;

#[derive(Debug, Clone)]
pub struct ParsedAttachment {
    pub filename: String,
    pub mime_type: String,
    pub size: usize,
    pub content: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ParsedMessage {
    pub message_id: String,
    pub from_address: String,
    pub from_name: Option<String>,
    pub to_addresses: Vec<String>,
    pub cc_addresses: Vec<String>,
    pub subject: String,
    pub date: String,
    pub body_text: String,
    pub body_html: Option<String>,
    pub attachments: Vec<ParsedAttachment>,
    pub is_noise: bool,
}

/// One mailbox for JSON / text read output (`name` + `address`).
#[derive(Debug, Clone, Serialize)]
pub struct MailboxEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub address: String,
}

/// Full envelope + body for `zmail read` / MCP (single parse of raw `.eml`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadForCli {
    pub message_id: String,
    pub from: MailboxEntry,
    pub subject: String,
    pub date: String,
    pub to: Vec<MailboxEntry>,
    pub cc: Vec<MailboxEntry>,
    pub bcc: Vec<MailboxEntry>,
    pub reply_to: Vec<MailboxEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<String>,
    /// `false` when To, Cc, and Bcc are all empty (e.g. omitted by provider or BCC-only copy).
    pub recipients_disclosed: bool,
    #[serde(rename = "body")]
    pub body_text: String,
}

fn strip_id_token(s: &str) -> String {
    s.trim().trim_matches(|c| c == '<' || c == '>').to_string()
}

fn extract_threading_from_headers(msg: &Message<'_>) -> (Option<String>, Vec<String>) {
    let mut in_reply = None;
    let mut refs = Vec::new();
    for (name, value) in msg.headers_raw() {
        let n = name.to_lowercase();
        if n == "in-reply-to" {
            let s = strip_id_token(value);
            if !s.is_empty() {
                in_reply = Some(s);
            }
        } else if n == "references" {
            for part in value.split_whitespace() {
                let s = strip_id_token(part);
                if !s.is_empty() {
                    refs.push(s);
                }
            }
        }
    }
    (in_reply, refs)
}

fn collect_address_entries(addr: Option<&Address<'_>>) -> Vec<MailboxEntry> {
    let Some(a) = addr else {
        return Vec::new();
    };
    match a {
        Address::List(v) => v
            .iter()
            .filter_map(|x| {
                let address = x.address.as_ref().map(|c| c.to_string())?;
                if address.is_empty() {
                    return None;
                }
                Some(MailboxEntry {
                    name: x
                        .name
                        .as_ref()
                        .map(|s| s.to_string())
                        .filter(|s| !s.is_empty()),
                    address,
                })
            })
            .collect(),
        Address::Group(g) => g
            .iter()
            .flat_map(|gr| gr.addresses.iter())
            .filter_map(|x| {
                let address = x.address.as_ref().map(|c| c.to_string())?;
                if address.is_empty() {
                    return None;
                }
                Some(MailboxEntry {
                    name: x
                        .name
                        .as_ref()
                        .map(|s| s.to_string())
                        .filter(|s| !s.is_empty()),
                    address,
                })
            })
            .collect(),
    }
}

fn collect_address_emails(addr: Option<&Address<'_>>) -> Vec<String> {
    let Some(a) = addr else {
        return Vec::new();
    };
    match a {
        Address::List(v) => v
            .iter()
            .filter_map(|x| x.address.as_ref().map(|c| c.to_string()))
            .collect(),
        Address::Group(g) => g
            .iter()
            .flat_map(|gr| gr.addresses.iter())
            .filter_map(|x| x.address.as_ref().map(|c| c.to_string()))
            .collect(),
    }
}

fn classify_noise(msg: &Message<'_>) -> bool {
    let mut has_list_unsubscribe = false;
    let mut has_list_id = false;
    let mut is_noise = false;
    for (name, value) in msg.headers_raw() {
        let name = name.to_lowercase();
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if name == "list-unsubscribe" {
            has_list_unsubscribe = true;
            continue;
        }
        if name == "list-id" {
            has_list_id = true;
            is_noise = true;
            break;
        }
        if name == "precedence" {
            let v = value.to_lowercase();
            if matches!(v.as_str(), "bulk" | "list" | "junk" | "auto") {
                return true;
            }
        }
        if name == "x-auto-response-suppress" {
            return true;
        }
    }
    if !is_noise && has_list_unsubscribe && has_list_id {
        is_noise = true;
    }
    is_noise
}

fn collect_attachments(msg: &Message<'_>) -> Vec<ParsedAttachment> {
    let mut out = Vec::new();
    for i in 0..msg.attachment_count() {
        let Some(part) = msg.attachment(i) else {
            continue;
        };
        let disp = part.content_disposition();
        if disp.map(|d| d.is_inline()).unwrap_or(false) {
            continue;
        }
        let Some(filename) = part
            .attachment_name()
            .map(str::to_string)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let body = match &part.body {
            PartType::Text(t) => t.as_bytes().to_vec(),
            PartType::Html(h) => h.as_bytes().to_vec(),
            PartType::Binary(b) | PartType::InlineBinary(b) => b.to_vec(),
            _ => continue,
        };
        let mime_type = part
            .content_type()
            .map(|ct| {
                ct.c_subtype
                    .as_ref()
                    .map(|st| format!("{}/{}", ct.c_type, st))
                    .unwrap_or_else(|| ct.c_type.to_string())
            })
            .unwrap_or_else(|| "application/octet-stream".into());
        let size = body.len();
        out.push(ParsedAttachment {
            filename,
            mime_type,
            size,
            content: body,
        });
    }
    out
}

/// Parse raw RFC822 bytes.
pub fn parse_raw_message(raw: &[u8]) -> ParsedMessage {
    let Some(msg) = MessageParser::default()
        .with_mime_headers()
        .with_date_headers()
        .with_address_headers()
        .parse(raw)
    else {
        return ParsedMessage {
            message_id: format!("<fallback-{}@local>", chrono::Utc::now().timestamp_millis()),
            from_address: String::new(),
            from_name: None,
            to_addresses: Vec::new(),
            cc_addresses: Vec::new(),
            subject: String::new(),
            date: chrono::Utc::now().to_rfc3339(),
            body_text: String::from_utf8_lossy(raw).into_owned(),
            body_html: None,
            attachments: Vec::new(),
            is_noise: false,
        };
    };

    let message_id = msg
        .message_id()
        .map(str::to_string)
        .unwrap_or_else(|| format!("<unknown-{}@local>", chrono::Utc::now().timestamp_millis()));

    let min_ts = chrono::DateTime::parse_from_rfc3339("1980-01-01T00:00:00Z")
        .unwrap()
        .timestamp();
    let max_ts = chrono::Utc::now().timestamp() + 86400;
    let date = msg.date().map_or_else(
        || chrono::Utc::now().to_rfc3339(),
        |d| {
            let ts = d.to_timestamp();
            if ts < min_ts || ts > max_ts {
                chrono::Utc::now().to_rfc3339()
            } else {
                // RFC3339 from mail-parser DateTime
                let s = d.to_rfc3339();
                chrono::DateTime::parse_from_rfc3339(&s)
                    .map(|dt| dt.with_timezone(&chrono::Utc).to_rfc3339())
                    .unwrap_or(s)
            }
        },
    );

    let (body_text, body_html) = if let Some(t) = msg.body_text(0) {
        (t.into_owned(), msg.body_html(0).map(|h| h.into_owned()))
    } else if let Some(h) = msg.body_html(0) {
        let html = h.into_owned();
        let md = htmd::convert(&html).unwrap_or(html.clone());
        (md, Some(html))
    } else {
        (String::new(), None)
    };

    let from_address = msg
        .from()
        .and_then(|a| match a {
            Address::List(v) => v.first(),
            Address::Group(g) => g.first().and_then(|gr| gr.addresses.first()),
        })
        .and_then(|addr| addr.address.as_ref().map(|s| s.to_string()))
        .unwrap_or_default();

    let from_name = msg
        .from()
        .and_then(|a| match a {
            Address::List(v) => v.first(),
            Address::Group(g) => g.first().and_then(|gr| gr.addresses.first()),
        })
        .and_then(|addr| addr.name.as_ref().map(|s| s.to_string()));

    let is_noise = classify_noise(&msg);

    ParsedMessage {
        message_id,
        from_address,
        from_name,
        to_addresses: collect_address_emails(msg.to()),
        cc_addresses: collect_address_emails(msg.cc()),
        subject: msg.subject().unwrap_or("").to_string(),
        date,
        body_text,
        body_html,
        attachments: collect_attachments(&msg),
        is_noise,
    }
}

fn extract_threading_from_raw_bytes(raw: &[u8]) -> (Option<String>, Vec<String>) {
    let Ok(s) = std::str::from_utf8(raw) else {
        return (None, Vec::new());
    };
    let header_end = s
        .find("\r\n\r\n")
        .or_else(|| s.find("\n\n"))
        .unwrap_or(s.len());
    let head = &s[..header_end];
    let mut in_reply = None;
    let mut refs = Vec::new();
    for line in head.lines() {
        let line = line.trim_end_matches('\r');
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("in-reply-to:") {
            let v = line.split_once(':').map(|(_, v)| v.trim()).unwrap_or("");
            let t = strip_id_token(v);
            if !t.is_empty() {
                in_reply = Some(t);
            }
        } else if lower.starts_with("references:") {
            let v = line.split_once(':').map(|(_, v)| v.trim()).unwrap_or("");
            for part in v.split_whitespace() {
                let t = strip_id_token(part);
                if !t.is_empty() {
                    refs.push(t);
                }
            }
        }
    }
    (in_reply, refs)
}

/// Single-parse path for `zmail read` / MCP: body plus To/Cc/Bcc/Reply-To and threading headers.
pub fn parse_read_full(raw: &[u8]) -> ReadForCli {
    let Some(msg) = MessageParser::default()
        .with_mime_headers()
        .with_date_headers()
        .with_address_headers()
        .parse(raw)
    else {
        let p = parse_raw_message(raw);
        let (in_reply_to, references) = extract_threading_from_raw_bytes(raw);
        let to = p
            .to_addresses
            .iter()
            .map(|a| MailboxEntry {
                name: None,
                address: a.clone(),
            })
            .collect();
        let cc = p
            .cc_addresses
            .iter()
            .map(|a| MailboxEntry {
                name: None,
                address: a.clone(),
            })
            .collect();
        let recipients_disclosed = !p.to_addresses.is_empty() || !p.cc_addresses.is_empty();
        return ReadForCli {
            message_id: p.message_id,
            from: MailboxEntry {
                name: p.from_name,
                address: p.from_address,
            },
            subject: p.subject,
            date: p.date,
            to,
            cc,
            bcc: Vec::new(),
            reply_to: Vec::new(),
            in_reply_to,
            references,
            recipients_disclosed,
            body_text: p.body_text,
        };
    };

    let message_id = msg
        .message_id()
        .map(str::to_string)
        .unwrap_or_else(|| format!("<unknown-{}@local>", chrono::Utc::now().timestamp_millis()));

    let min_ts = chrono::DateTime::parse_from_rfc3339("1980-01-01T00:00:00Z")
        .unwrap()
        .timestamp();
    let max_ts = chrono::Utc::now().timestamp() + 86400;
    let date = msg.date().map_or_else(
        || chrono::Utc::now().to_rfc3339(),
        |d| {
            let ts = d.to_timestamp();
            if ts < min_ts || ts > max_ts {
                chrono::Utc::now().to_rfc3339()
            } else {
                let s = d.to_rfc3339();
                chrono::DateTime::parse_from_rfc3339(&s)
                    .map(|dt| dt.with_timezone(&chrono::Utc).to_rfc3339())
                    .unwrap_or(s)
            }
        },
    );

    let (body_text, _body_html) = if let Some(t) = msg.body_text(0) {
        (t.into_owned(), msg.body_html(0).map(|h| h.into_owned()))
    } else if let Some(h) = msg.body_html(0) {
        let html = h.into_owned();
        let md = htmd::convert(&html).unwrap_or(html.clone());
        (md, Some(html))
    } else {
        (String::new(), None)
    };

    let from_address = msg
        .from()
        .and_then(|a| match a {
            Address::List(v) => v.first(),
            Address::Group(g) => g.first().and_then(|gr| gr.addresses.first()),
        })
        .and_then(|addr| addr.address.as_ref().map(|s| s.to_string()))
        .unwrap_or_default();

    let from_name = msg
        .from()
        .and_then(|a| match a {
            Address::List(v) => v.first(),
            Address::Group(g) => g.first().and_then(|gr| gr.addresses.first()),
        })
        .and_then(|addr| addr.name.as_ref().map(|s| s.to_string()));

    let to = collect_address_entries(msg.to());
    let cc = collect_address_entries(msg.cc());
    let bcc = collect_address_entries(msg.bcc());
    let reply_to = collect_address_entries(msg.reply_to());
    let (in_reply_to, references) = extract_threading_from_headers(&msg);
    let recipients_disclosed = !to.is_empty() || !cc.is_empty() || !bcc.is_empty();

    ReadForCli {
        message_id,
        from: MailboxEntry {
            name: from_name,
            address: from_address,
        },
        subject: msg.subject().unwrap_or("").to_string(),
        date,
        to,
        cc,
        bcc,
        reply_to,
        in_reply_to,
        references,
        recipients_disclosed,
        body_text,
    }
}
