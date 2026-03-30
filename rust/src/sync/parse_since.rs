//! Relative `--since` spec → `YYYY-MM-DD` (mirrors `src/sync/parse-since.ts`).

use regex::Regex;
use std::sync::LazyLock;

static SINCE_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(\d+)([dwmy])?$").expect("regex"));

/// Parse e.g. `7d`, `5w`, `3m`, `2y` or bare `7` (days) into UTC calendar date `YYYY-MM-DD`.
pub fn parse_since_to_date(since: &str) -> Result<String, String> {
    let trimmed = since.trim();
    let caps = SINCE_REGEX
        .captures(trimmed)
        .ok_or_else(|| {
            format!(
                r#"Invalid --since value: "{since}". Use a number plus optional unit: d (days), w (weeks), m (months), y (years). Example: 7d, 5w, 3m, 2y."#
            )
        })?;
    let num: i64 = caps[1]
        .parse()
        .map_err(|_| format!("Invalid --since value: \"{since}\""))?;
    if num <= 0 {
        return Err(format!(
            r#"Invalid --since value: "{since}". Number must be positive."#
        ));
    }
    let unit = caps
        .get(2)
        .map(|m| m.as_str().to_lowercase())
        .unwrap_or_else(|| "d".into());
    let days = num
        * match unit.as_str() {
            "d" => 1,
            "w" => 7,
            "m" => 30,
            "y" => 365,
            _ => 1,
        };
    let now = chrono::Utc::now().date_naive();
    let target = now - chrono::Duration::days(days);
    Ok(target.format("%Y-%m-%d").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_number_is_days() {
        let d = parse_since_to_date("1").unwrap();
        assert!(regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$")
            .unwrap()
            .is_match(&d));
    }

    #[test]
    fn units_dwmy() {
        for spec in ["7d", "2w", "3m", "1y"] {
            let d = parse_since_to_date(spec).unwrap();
            assert_eq!(d.len(), 10);
        }
    }

    #[test]
    fn rejects_zero_and_invalid() {
        assert!(parse_since_to_date("0d").is_err());
        assert!(parse_since_to_date("").is_err());
        assert!(parse_since_to_date("xyz").is_err());
    }
}
