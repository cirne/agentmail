//! MIME parse → structured message (mirrors `src/sync/parse-message.ts`).

use mail_parser::{Address, Message, MessageParser, MimeHeaders, PartType};

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
        (
            t.into_owned(),
            msg.body_html(0).map(|h| h.into_owned()),
        )
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
