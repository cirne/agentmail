//! `zmail ask` guardrails (LLM pipeline stub).

use chrono::{Datelike, Utc};

/// Rejects natural-language questions that imply a date range older than ~1 year (TS `agent.test.ts`).
pub fn ask_rejects_stale_date_range(question: &str) -> Result<(), String> {
    let q = question.to_lowercase();
    if q.contains("two years ago") || q.contains("2 years ago") || q.contains("three years ago") {
        return Err(
            "Questions about email older than roughly one year are not supported yet.".into(),
        );
    }
    Ok(())
}

/// Stub compose: returns fixed body (real impl would call OpenAI).
pub fn draft_rewrite_stub(_instruction: &str, body: &str) -> String {
    format!("{body}\n\n[edited]")
}

/// If question mentions a calendar year before (now - 1 year), reject.
pub fn ask_rejects_old_explicit_year(question: &str) -> Result<(), String> {
    let year_now = Utc::now().year();
    let cutoff_year = year_now - 1;
    let re = regex::Regex::new(r"\b(19\d{2}|20\d{2})\b").unwrap();
    for cap in re.captures_iter(question) {
        if let Ok(y) = cap[1].parse::<i32>() {
            if y < cutoff_year {
                return Err("Date range too old for ask.".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_two_years_ago() {
        assert!(ask_rejects_stale_date_range("email from two years ago").is_err());
        assert!(ask_rejects_stale_date_range("2 years ago stuff").is_err());
    }

    #[test]
    fn allows_recent_wording() {
        assert!(ask_rejects_stale_date_range("last week invoices").is_ok());
    }

    #[test]
    fn draft_rewrite_appends_marker() {
        let out = draft_rewrite_stub("x", "Hello");
        assert!(out.contains("Hello"));
        assert!(out.contains("[edited]"));
    }

    #[test]
    fn rejects_very_old_explicit_year() {
        assert!(ask_rejects_old_explicit_year("mail from 1999").is_err());
    }

    #[test]
    fn allows_recent_year_in_question() {
        let y = Utc::now().year();
        let q = format!("What happened in {y}?");
        assert!(ask_rejects_old_explicit_year(&q).is_ok());
    }
}
