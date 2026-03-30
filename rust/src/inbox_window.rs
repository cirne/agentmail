//! Inbox window parsing (`src/inbox/parse-window.ts`).

use chrono::{Duration, Utc};
use regex::Regex;
use std::sync::LazyLock;

static ROLLING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^(\d+)([dhmwy])?$").unwrap());
static ISO_DATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d{4})-(\d{2})-(\d{2})$").unwrap());

fn hours_per_unit(u: char) -> Option<i64> {
    Some(match u {
        'h' => 1,
        'd' => 24,
        'w' => 24 * 7,
        'm' => 24 * 30,
        'y' => 24 * 365,
        _ => return None,
    })
}

/// ISO 8601 UTC cutoff: messages on or after this instant.
pub fn parse_inbox_window_to_iso_cutoff(spec: &str) -> Result<String, String> {
    let trimmed = spec.trim();
    if trimmed.is_empty() {
        return Err("Inbox window spec is empty.".into());
    }
    if let Some(c) = ISO_DATE.captures(trimmed) {
        return Ok(format!("{}-{}-{}T00:00:00.000Z", &c[1], &c[2], &c[3]));
    }
    let Some(c) = ROLLING.captures(trimmed) else {
        return Err(format!(
            "Invalid inbox window: \"{trimmed}\". Use e.g. 24h, 3d, 1w, or YYYY-MM-DD."
        ));
    };
    let num: i64 = c[1].parse().map_err(|_| "bad number".to_string())?;
    let unit = c
        .get(2)
        .map(|m| m.as_str().to_lowercase().chars().next().unwrap_or('d'))
        .unwrap_or('d');
    let hpu = hours_per_unit(unit).ok_or_else(|| format!("Invalid unit in \"{trimmed}\""))?;
    if num <= 0 {
        return Err(format!(
            "Invalid inbox window: \"{trimmed}\". Number must be positive."
        ));
    }
    let hours = num * hpu;
    let cutoff = Utc::now() - Duration::hours(hours);
    Ok(cutoff.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_date_midnight_z() {
        let s = parse_inbox_window_to_iso_cutoff("2026-03-15").unwrap();
        assert!(s.starts_with("2026-03-15T00:00:00.000Z"));
    }

    #[test]
    fn rolling_24h_ok() {
        let s = parse_inbox_window_to_iso_cutoff("24h").unwrap();
        assert!(s.ends_with('Z'));
        assert!(s.contains('T'));
    }

    #[test]
    fn rejects_empty_and_bad() {
        assert!(parse_inbox_window_to_iso_cutoff("").is_err());
        assert!(parse_inbox_window_to_iso_cutoff("not-a-window").is_err());
        assert!(parse_inbox_window_to_iso_cutoff("0d").is_err());
    }
}
