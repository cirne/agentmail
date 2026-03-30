//! Fuzzy string helpers (`fastest-levenshtein` parity via `strsim`).

/// Single-character typo tolerance on short tokens.
pub fn fuzzy_name_token_match(token: &str, query: &str) -> bool {
    let t = token.trim().to_lowercase();
    let q = query.trim().to_lowercase();
    if t.is_empty() || q.is_empty() {
        return false;
    }
    if t == q {
        return true;
    }
    if t.len() > 32 || q.len() > 32 {
        return false;
    }
    strsim::levenshtein(&t, &q) <= 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_match() {
        assert!(fuzzy_name_token_match("Lewis", "lewis"));
    }

    #[test]
    fn one_char_typo() {
        assert!(fuzzy_name_token_match("Lewis", "Levis"));
    }

    #[test]
    fn too_far_apart() {
        assert!(!fuzzy_name_token_match("Lewis", "Smith"));
    }

    #[test]
    fn empty_tokens() {
        assert!(!fuzzy_name_token_match("", "a"));
        assert!(!fuzzy_name_token_match("a", ""));
    }

    #[test]
    fn long_tokens_rejected() {
        let long = "a".repeat(33);
        assert!(!fuzzy_name_token_match(&long, "a"));
    }
}
