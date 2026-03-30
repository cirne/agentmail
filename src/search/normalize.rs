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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lowercases_addresses() {
        assert_eq!(
            normalize_address("LewisCirne@MAC.COM"),
            "lewiscirne@mac.com"
        );
        assert_eq!(
            normalize_address("DONNA.WILCOX@GMAIL.COM"),
            "donnawilcox@gmail.com"
        );
    }

    #[test]
    fn strips_dots_from_local_part() {
        assert_eq!(
            normalize_address("lewis.cirne@gmail.com"),
            "lewiscirne@gmail.com"
        );
        assert_eq!(
            normalize_address("donna.wilcox@greenlonghorninc.com"),
            "donnawilcox@greenlonghorninc.com"
        );
    }

    #[test]
    fn strips_plus_aliases() {
        assert_eq!(
            normalize_address("lewiscirne+bounti@gmail.com"),
            "lewiscirne@gmail.com"
        );
        assert_eq!(
            normalize_address("lewiscirne+elysian@gmail.com"),
            "lewiscirne@gmail.com"
        );
        assert_eq!(
            normalize_address("user+tag+more@example.com"),
            "user@example.com"
        );
    }

    #[test]
    fn edge_cases() {
        assert_eq!(
            normalize_address("lewiscirne@gmail.com"),
            "lewiscirne@gmail.com"
        );
        assert_eq!(normalize_address("user@example.com"), "user@example.com");
        assert_eq!(
            normalize_address("user+tag@example.com"),
            "user@example.com"
        );
    }

    #[test]
    fn preserves_domain_dots() {
        assert_eq!(
            normalize_address("user@mail.example.com"),
            "user@mail.example.com"
        );
        assert_eq!(
            normalize_address("user@sub.domain.example.com"),
            "user@sub.domain.example.com"
        );
    }

    #[test]
    fn invalid_emails_graceful() {
        assert_eq!(normalize_address("no-at-sign"), "no-at-sign");
        assert_eq!(normalize_address("@domain.com"), "@domain.com");
    }
}
