//! Infer display names from local-part (`src/search/infer-name.ts`).

use regex::Regex;
use std::sync::LazyLock;

fn capitalize_words(s: &str) -> String {
    s.split_whitespace()
        .map(|word| {
            let mut c = word.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().to_string() + &c.as_str().to_lowercase(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

static RE_DOT_UNDERSCORE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([a-z]+)[._]([a-z]+)$").unwrap());
static RE_CAMEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([a-z]+)([A-Z][a-z]+)$").unwrap());
static RE_SINGLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([a-z])([a-z]{5,})$").unwrap());

const SKIP_WORDS: &[&str] = &[
    "the",
    "my",
    "our",
    "new",
    "old",
    "recipient",
    "sender",
    "user",
    "admin",
    "support",
    "info",
    "contact",
    "mail",
    "email",
    "noreply",
    "no-reply",
];

const COMMON_FIRST: &[&str] = &[
    "john", "jane", "mary", "mike", "dave", "bob", "tom", "tim", "dan", "sam", "ben", "joe",
];

const COMMON_ENDINGS: &[&str] = &[
    "an", "en", "in", "on", "er", "el", "al", "ey", "ly", "ie", "ney", "ley",
];

fn consonant_start(s: &str) -> bool {
    s.chars().next().is_some_and(|c| {
        matches!(
            c,
            'b' | 'c'
                | 'd'
                | 'f'
                | 'g'
                | 'h'
                | 'j'
                | 'k'
                | 'l'
                | 'm'
                | 'n'
                | 'p'
                | 'q'
                | 'r'
                | 's'
                | 't'
                | 'v'
                | 'w'
                | 'x'
                | 'y'
                | 'z'
        )
    })
}

/// Heuristic sync inference from full email address.
pub fn infer_name_from_address(address: &str) -> Option<String> {
    let lower_full = address.to_lowercase();
    let mut local_part = lower_full.split('@').next()?.to_string();
    if let Some((base, _)) = local_part.split_once('+') {
        local_part = base.to_string();
    }

    if local_part.len() < 3 {
        return None;
    }
    if local_part.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }

    if let Some(c) = RE_DOT_UNDERSCORE.captures(&local_part) {
        let first = c.get(1).unwrap().as_str();
        let last = c.get(2).unwrap().as_str();
        if first.len() >= 2 && last.len() >= 2 {
            return Some(capitalize_words(&format!("{first} {last}")));
        }
    }

    let orig_local = address.split('@').next().unwrap_or("");
    if let Some(c) = RE_CAMEL.captures(orig_local) {
        let first = c.get(1).unwrap().as_str();
        let last = c.get(2).unwrap().as_str();
        if first.len() >= 2 && last.len() >= 2 {
            return Some(capitalize_words(&format!(
                "{} {}",
                first.to_lowercase(),
                last.to_lowercase()
            )));
        }
    }

    if SKIP_WORDS.contains(&local_part.as_str()) {
        return None;
    }

    // All-lowercase splits (scored)
    let first_lengths = [4usize, 5, 6, 3, 7];
    let mut valid_splits: Vec<(String, String, i32)> = Vec::new();
    for i in first_lengths {
        if local_part.len() < i + 4 {
            continue;
        }
        let first = &local_part[..i];
        let last = &local_part[i..];
        if first.len() >= 3 && first.len() <= 7 && last.len() >= 4 {
            if SKIP_WORDS.contains(&first) {
                continue;
            }
            if SKIP_WORDS.iter().any(|w| local_part.starts_with(w)) {
                continue;
            }
            if first.len() <= 4 && last.len() <= 6 {
                let ambiguous = ["son", "sen", "man", "ton"];
                if ambiguous.iter().any(|e| last.ends_with(e)) {
                    continue;
                }
            }
            let mut score: i32 = 0;
            if (4..=6).contains(&first.len()) {
                score += 10;
            }
            if (7..=8).contains(&first.len()) {
                score += 8;
            }
            if last.len() >= 5 {
                score += 5;
            }
            score += last.len().min(7) as i32;
            if COMMON_ENDINGS.iter().any(|e| first.ends_with(e)) {
                score += 6;
            }
            if last.len() > first.len() + 3 {
                score -= 2;
            }
            if consonant_start(last) {
                score += 2;
            }
            valid_splits.push((first.to_string(), last.to_string(), score));
        }
    }

    if !valid_splits.is_empty() {
        valid_splits.sort_by(|a, b| b.2.cmp(&a.2));
        let best = &valid_splits[0];
        let has_name_ending = COMMON_ENDINGS.iter().any(|e| best.0.ends_with(e));
        let is_common_first = COMMON_FIRST.contains(&best.0.as_str());
        const MIN_SCORE: i32 = 20;
        const HIGH_SCORE: i32 = 24;
        if best.2 >= MIN_SCORE && (has_name_ending || best.2 >= HIGH_SCORE || is_common_first) {
            return Some(capitalize_words(&format!("{} {}", best.0, best.1)));
        }
    }

    if let Some(c) = RE_SINGLE.captures(&local_part) {
        let initial = c.get(1).unwrap().as_str();
        let last = c.get(2).unwrap().as_str();
        let ambiguous = ["son", "sen", "man", "ton"];
        let looks_ambiguous = ambiguous
            .iter()
            .any(|e| last.ends_with(e) && last.len() <= 7);
        if (5..=6).contains(&last.len()) && consonant_start(last) && !looks_ambiguous {
            return Some(capitalize_words(&format!(
                "{} {}",
                initial.to_uppercase(),
                last
            )));
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dot_separated_local_part() {
        assert_eq!(
            infer_name_from_address("lewis.cirne@alum.dartmouth.org").as_deref(),
            Some("Lewis Cirne")
        );
        assert_eq!(
            infer_name_from_address("katelyn.cirne@gmail.com").as_deref(),
            Some("Katelyn Cirne")
        );
        assert_eq!(
            infer_name_from_address("alan.finley@example.com").as_deref(),
            Some("Alan Finley")
        );
    }

    #[test]
    fn underscore_separated() {
        assert_eq!(
            infer_name_from_address("katelyn_cirne@icloud.com").as_deref(),
            Some("Katelyn Cirne")
        );
        assert_eq!(
            infer_name_from_address("john_smith@example.com").as_deref(),
            Some("John Smith")
        );
    }

    #[test]
    fn camel_case_local_part() {
        assert_eq!(
            infer_name_from_address("lewisCirne@example.com").as_deref(),
            Some("Lewis Cirne")
        );
        assert_eq!(
            infer_name_from_address("johnSmith@example.com").as_deref(),
            Some("John Smith")
        );
    }

    #[test]
    fn all_lowercase_clear_patterns() {
        assert_eq!(
            infer_name_from_address("alanfinley@example.com").as_deref(),
            Some("Alan Finley")
        );
        assert_eq!(
            infer_name_from_address("johnsmith@example.com").as_deref(),
            Some("John Smith")
        );
        assert_eq!(
            infer_name_from_address("whitneyallen@example.com").as_deref(),
            Some("Whitney Allen")
        );
    }

    #[test]
    fn single_letter_prefix() {
        assert_eq!(
            infer_name_from_address("abrown@somecompany.com").as_deref(),
            Some("A Brown")
        );
        assert_eq!(
            infer_name_from_address("jsmith@example.com").as_deref(),
            Some("J Smith")
        );
        assert_eq!(infer_name_from_address("sjohnson@example.com"), None);
    }

    #[test]
    fn skip_words_null() {
        assert_eq!(infer_name_from_address("recipient@example.com"), None);
        assert_eq!(infer_name_from_address("noreply@example.com"), None);
        assert_eq!(infer_name_from_address("support@example.com"), None);
        assert_eq!(infer_name_from_address("admin@example.com"), None);
    }

    #[test]
    fn invalid_short_or_numeric() {
        assert_eq!(infer_name_from_address("ab@example.com"), None);
        assert_eq!(infer_name_from_address("a@example.com"), None);
        assert_eq!(infer_name_from_address("123@example.com"), None);
    }

    #[test]
    fn ambiguous_username_like() {
        assert_eq!(infer_name_from_address("fredbrown@example.com"), None);
    }
}
