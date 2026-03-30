//! Markdown draft body → plain text for SMTP (mirrors `draft-body-plain.ts`).

use regex::Regex;

/// Convert draft body (often Markdown) to plain text for `text/plain`.
pub fn draft_markdown_to_plain_text(body: &str) -> String {
    let normalized = body.replace("\r\n", "\n");
    let mut out = String::new();
    for event in pulldown_cmark::Parser::new_ext(
        &normalized,
        pulldown_cmark::Options::ENABLE_TABLES | pulldown_cmark::Options::ENABLE_STRIKETHROUGH,
    ) {
        use pulldown_cmark::Event;
        match event {
            Event::Text(t) | Event::Code(t) => out.push_str(&t),
            Event::SoftBreak | Event::HardBreak => out.push('\n'),
            _ => {}
        }
    }
    let re = Regex::new(r"\n{3,}").expect("regex");
    re.replace_all(&out, "\n\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_bold_and_collapses_blank_lines() {
        let s = draft_markdown_to_plain_text("Hello **world**\n\n\n\nMore.");
        assert!(s.contains("Hello"));
        assert!(s.contains("world"));
        assert!(!s.contains("**"));
    }
}
