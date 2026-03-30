//! Extract `In-Reply-To` / `References` from raw RFC 822 bytes.

use mail_parser::MessageParser;

fn strip_id(s: &str) -> String {
    s.trim().trim_matches(|c| c == '<' || c == '>').to_string()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_in_reply_and_references() {
        let raw = b"From: a@b\r\nIn-Reply-To: <abc@d>\r\nReferences: <x@y> <z@w>\r\n\r\n";
        let (ir, refs) = extract_threading_headers(raw);
        assert_eq!(ir.as_deref(), Some("abc@d"));
        assert_eq!(refs, vec!["x@y".to_string(), "z@w".to_string()]);
    }

    #[test]
    fn strip_angle_brackets() {
        let raw = b"In-Reply-To: abc@test\r\n\r\n";
        let (ir, _) = extract_threading_headers(raw);
        assert_eq!(ir.as_deref(), Some("abc@test"));
    }

    #[test]
    fn invalid_bytes_empty() {
        let (ir, refs) = extract_threading_headers(&[0xff, 0xfe]);
        assert!(ir.is_none());
        assert!(refs.is_empty());
    }
}
