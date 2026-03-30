//! Extract `In-Reply-To` / `References` from raw RFC 822 bytes.

use mail_parser::MessageParser;

fn strip_id(s: &str) -> String {
    s.trim()
        .trim_matches(|c| c == '<' || c == '>')
        .to_string()
}

pub fn extract_threading_headers(raw: &[u8]) -> (Option<String>, Vec<String>) {
    let Some(msg) = MessageParser::default().parse(raw) else {
        return (None, Vec::new());
    };
    let mut in_reply = None;
    let mut refs = Vec::new();
    for (name, value) in msg.headers_raw() {
        let n = name.to_lowercase();
        if n == "in-reply-to" {
            let s = strip_id(value);
            if !s.is_empty() {
                in_reply = Some(s);
            }
        } else if n == "references" {
            for part in value.split_whitespace() {
                let s = strip_id(part);
                if !s.is_empty() {
                    refs.push(s);
                }
            }
        }
    }
    (in_reply, refs)
}
