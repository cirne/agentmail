//! Signature block parsing (`src/search/signature.ts` subset).

use phonenumber::{country, Mode};
use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedSignature {
    pub phone: Option<String>,
    pub title: Option<String>,
    pub company: Option<String>,
    pub urls: Vec<String>,
    pub alt_emails: Vec<String>,
}

static RE_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)https?://[^\s]+").unwrap());
static RE_EMAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\w.+-]+@[\w.-]+\.\w{2,}").unwrap());
static RE_PHONE_CANDIDATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\(?\s*\d{3}\s*\)?[-.\s]*\d{3}[-.\s]*\d{4}").unwrap());

fn try_parse_us_phone(slice: &str) -> Option<String> {
    let n = phonenumber::parse(Some(country::Id::US), slice).ok()?;
    if !n.is_valid() {
        return None;
    }
    Some(n.format().mode(Mode::National).to_string().replace(' ', ""))
}

/// First plausible US phone in text (libphonenumber validation when possible).
pub fn extract_phone_from_text(text: &str) -> Option<String> {
    for m in RE_PHONE_CANDIDATE.find_iter(text) {
        if let Some(p) = try_parse_us_phone(m.as_str()) {
            return Some(p);
        }
    }
    None
}

/// Structured parse of a signature block (already isolated).
pub fn parse_signature_block(signature_text: &str, sender_address: &str) -> ExtractedSignature {
    let mut out = ExtractedSignature {
        phone: extract_phone_from_text(signature_text),
        ..Default::default()
    };

    for cap in RE_URL.captures_iter(signature_text) {
        let u = cap.get(0).unwrap().as_str().trim().to_string();
        let lower = u.to_lowercase();
        if !lower.contains("unsubscribe") && !lower.contains("utm_") {
            out.urls.push(u);
        }
    }

    let sender_l = sender_address.to_lowercase();
    for cap in RE_EMAIL.find_iter(signature_text) {
        let e = cap.as_str().to_lowercase();
        if e != sender_l {
            out.alt_emails.push(e);
        }
    }

    for line in signature_text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
    {
        if line.len() > 80 {
            continue;
        }
        if RE_URL.is_match(line) || RE_PHONE_CANDIDATE.is_match(line) {
            continue;
        }
        if let Some(idx) = line.find(',') {
            let title = line[..idx].trim();
            let company = line[idx + 1..].trim();
            if title.len() < 50 && company.len() < 80 && !title.is_empty() && !company.is_empty() {
                out.title = Some(title.to_string());
                out.company = Some(company.to_string());
                break;
            }
        }
    }

    out
}

/// Extract `-- ` / `___` signature then parse.
pub fn extract_signature_data(body: &str, sender_address: &str) -> Option<ExtractedSignature> {
    let sig = extract_signature(body)?;
    Some(parse_signature_block(&sig, sender_address))
}

fn extract_signature(body: &str) -> Option<String> {
    if body.len() < 20 {
        return None;
    }
    let lines: Vec<&str> = body.lines().collect();
    if lines.len() < 3 {
        return None;
    }
    let mut sig_start: Option<usize> = None;
    for i in (0..lines.len()).rev().take(20) {
        let t = lines[i].trim();
        if t == "--" {
            sig_start = Some(i + 1);
            break;
        }
    }
    if sig_start.is_none() {
        for i in (0..lines.len()).rev().take(20) {
            let t = lines[i].trim();
            if t == "___" || t == "---" || t.starts_with("___") || t.starts_with("---") {
                sig_start = Some(i + 1);
                break;
            }
        }
    }
    let start = sig_start?;
    if start >= lines.len() {
        return None;
    }
    let mut text = lines[start..].join("\n");
    text = text.replace("Sent from my iPhone", "");
    text = text.replace("sent from my iphone", "");
    let t = text.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_rfc3676_separator() {
        let body = "Hello world\n\n-- \nJohn Doe\nCEO, Acme Corp\n+1-555-123-4567";
        let sig = extract_signature(body).expect("sig");
        assert!(sig.contains("John Doe"));
        assert!(sig.contains("CEO, Acme Corp"));
        assert!(sig.contains("555-123-4567") || sig.contains("5551234567"));
    }

    #[test]
    fn extract_underscore_separator() {
        let body = "Message text\n\n___\nJane Smith\nVP Operations";
        let sig = extract_signature(body).expect("sig");
        assert!(sig.contains("Jane Smith"));
    }

    #[test]
    fn strips_iphone_boilerplate() {
        let body = "Message\n\n-- \nSent from my iPhone\nJohn Doe";
        let sig = extract_signature(body).expect("sig");
        assert!(!sig.to_lowercase().contains("iphone"));
        assert!(sig.contains("John Doe"));
    }

    #[test]
    fn no_signature_short_body() {
        assert!(extract_signature("short").is_none());
    }

    #[test]
    fn parse_block_phone() {
        let sig = "John Doe\n(512) 555-1234";
        let r = parse_signature_block(sig, "john@example.com");
        assert!(r.phone.is_some());
        let p = r.phone.unwrap();
        assert!(p.contains("512") && p.contains("555"));
    }

    #[test]
    fn parse_title_company() {
        let sig = "John Doe\nCEO, Acme Corp";
        let r = parse_signature_block(sig, "john@example.com");
        assert_eq!(r.title.as_deref(), Some("CEO"));
        assert_eq!(r.company.as_deref(), Some("Acme Corp"));
    }

    #[test]
    fn parse_urls_skip_unsubscribe() {
        let sig = "Hi\nhttps://linkedin.com/in/x\nhttps://x.com?utm_source=1";
        let r = parse_signature_block(sig, "a@b.com");
        assert!(r.urls.iter().any(|u| u.contains("linkedin")));
        assert!(!r.urls.iter().any(|u| u.contains("utm_")));
    }

    #[test]
    fn parse_alt_email_not_sender() {
        let sig = "John Doe\njohn.personal@gmail.com";
        let r = parse_signature_block(sig, "john@company.com");
        assert!(r.alt_emails.contains(&"john.personal@gmail.com".into()));
        assert!(!r.alt_emails.contains(&"john@company.com".into()));
    }

    #[test]
    fn extract_signature_data_full() {
        let body = "Message\n\n-- \nJohn Doe\nCEO, Acme Corp\n(512) 555-1234\nhttps://example.com";
        let r = extract_signature_data(body, "john@example.com").expect("data");
        assert_eq!(r.title.as_deref(), Some("CEO"));
        assert!(r.phone.is_some());
        assert!(!r.urls.is_empty());
    }

    #[test]
    fn extract_signature_data_no_marker() {
        let body = "Just a message with enough length here";
        assert!(extract_signature_data(body, "sender@example.com").is_none());
    }
}
