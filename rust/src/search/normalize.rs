//! Email normalization (subset of `src/search/normalize.ts`).

/// Lowercase, strip dots in local-part, strip `+` alias (Gmail-style).
pub fn normalize_address(email: &str) -> String {
    let lower = email.to_lowercase();
    let Some((local, domain)) = lower.split_once('@') else {
        return lower;
    };
    let no_dots: String = local.chars().filter(|&c| c != '.').collect();
    let final_local = no_dots
        .split_once('+')
        .map(|(a, _)| a.to_string())
        .unwrap_or(no_dots);
    format!("{final_local}@{domain}")
}
