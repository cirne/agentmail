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

static RE_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)https?://[^\s]+").unwrap());
static RE_EMAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\w.+-]+@[\w.-]+\.\w{2,}").unwrap());
static RE_PHONE_CANDIDATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\(?\s*\d{3}\s*\)?[-.\s]*\d{3}[-.\s]*\d{4}").unwrap()
});

fn try_parse_us_phone(slice: &str) -> Option<String> {
    let n = phonenumber::parse(Some(country::Id::US), slice).ok()?;
    if !n.is_valid() {
        return None;
    }
    Some(
        n.format()
            .mode(Mode::National)
            .to_string()
            .replace(' ', ""),
    )
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
    let mut out = ExtractedSignature::default();
    out.phone = extract_phone_from_text(signature_text);

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

    for line in signature_text.lines().map(str::trim).filter(|l| !l.is_empty()) {
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
