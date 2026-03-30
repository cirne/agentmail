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
