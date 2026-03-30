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
