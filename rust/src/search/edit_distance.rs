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
