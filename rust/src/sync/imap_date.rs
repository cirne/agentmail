//! `YYYY-MM-DD` → IMAP `SINCE` date (`DD-Mon-YYYY`).

use chrono::{Datelike, NaiveDate};

/// Convert config/CLI since date to IMAP SEARCH `SINCE` token.
pub fn ymd_to_imap_since(ymd: &str) -> Result<String, String> {
    let d = NaiveDate::parse_from_str(ymd.trim(), "%Y-%m-%d")
        .map_err(|_| format!("Invalid from date: {ymd}"))?;
    let mon = match d.month() {
        1 => "Jan",
        2 => "Feb",
        3 => "Mar",
        4 => "Apr",
        5 => "May",
        6 => "Jun",
        7 => "Jul",
        8 => "Aug",
        9 => "Sep",
        10 => "Oct",
        11 => "Nov",
        12 => "Dec",
        _ => "Jan",
    };
    Ok(format!("{}-{}-{}", d.day(), mon, d.year()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_imap_since() {
        assert_eq!(ymd_to_imap_since("2026-03-15").unwrap(), "15-Mar-2026");
    }
}
