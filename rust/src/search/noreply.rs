//! Noreply heuristics (`src/search/noreply.ts`).

use regex::Regex;
use std::sync::LazyLock;

static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)^no-?reply@",
        r"(?i)^mailer-daemon@",
        r"(?i)^postmaster@",
        r"(?i)^notifications?@",
        r"(?i)^donotreply@",
        r"(?i)^bounce",
        r"(?i)^news(letter)?@",
        r"(?i)^alerts?@",
    ]
    .into_iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});

pub fn is_noreply(address: &str) -> bool {
    let lower = address.to_lowercase();
    PATTERNS.iter().any(|re| re.is_match(&lower))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_noreply_patterns() {
        for addr in [
            "noreply@example.com",
            "no-reply@example.com",
            "mailer-daemon@example.com",
            "postmaster@example.com",
            "notifications@example.com",
            "notification@example.com",
            "donotreply@example.com",
            "bounce@example.com",
            "newsletter@example.com",
            "news@example.com",
            "alerts@example.com",
            "alert@example.com",
        ] {
            assert!(is_noreply(addr), "{addr}");
        }
    }

    #[test]
    fn does_not_match_similar() {
        for addr in [
            "donna.noreply@example.com",
            "reply@example.com",
            "lewiscirne@gmail.com",
            "donnawilcox@greenlonghorninc.com",
        ] {
            assert!(!is_noreply(addr), "{addr}");
        }
    }

    #[test]
    fn case_insensitive() {
        assert!(is_noreply("NO-REPLY@EXAMPLE.COM"));
        assert!(is_noreply("Mailer-Daemon@Example.com"));
    }
}
