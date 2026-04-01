//! Shared deterministic mail category helpers.

pub const CATEGORY_PROMOTIONAL: &str = "promotional";
pub const CATEGORY_SOCIAL: &str = "social";
pub const CATEGORY_FORUM: &str = "forum";
pub const CATEGORY_LIST: &str = "list";
pub const CATEGORY_AUTOMATED: &str = "automated";
pub const CATEGORY_BULK: &str = "bulk";
pub const CATEGORY_SPAM: &str = "spam";

pub const DEFAULT_EXCLUDED_CATEGORIES: [&str; 7] = [
    CATEGORY_PROMOTIONAL,
    CATEGORY_SOCIAL,
    CATEGORY_FORUM,
    CATEGORY_LIST,
    CATEGORY_BULK,
    CATEGORY_SPAM,
    CATEGORY_AUTOMATED,
];

pub fn is_default_excluded_category(category: Option<&str>) -> bool {
    category
        .map(|value| DEFAULT_EXCLUDED_CATEGORIES.contains(&value))
        .unwrap_or(false)
}

pub fn default_category_filter_sql(column_expr: &str) -> String {
    format!(
        "({column_expr} IS NULL OR {column_expr} NOT IN ('promotional', 'social', 'forum', 'list', 'bulk', 'spam', 'automated'))"
    )
}

pub fn parse_category_list(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    for part in raw.split(',') {
        let category = part.trim().to_ascii_lowercase();
        if category.is_empty() || out.contains(&category) {
            continue;
        }
        out.push(category);
    }
    out
}

pub fn label_to_category(label: &str) -> Option<&'static str> {
    let lower = label.trim().to_ascii_lowercase();
    match lower.as_str() {
        "promotions" | "\\promotions" => Some(CATEGORY_PROMOTIONAL),
        "social" | "\\social" => Some(CATEGORY_SOCIAL),
        "forums" | "\\forums" => Some(CATEGORY_FORUM),
        "spam" | "\\spam" | "junk" | "\\junk" => Some(CATEGORY_SPAM),
        "bulk" | "\\bulk" => Some(CATEGORY_BULK),
        _ if lower.starts_with("[superhuman]/ai/") => {
            let cat = &lower["[superhuman]/ai/".len()..];
            match cat {
                "marketing" | "news" | "pitch" => Some(CATEGORY_PROMOTIONAL),
                "social" => Some(CATEGORY_SOCIAL),
                _ => None,
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_category_list_splits_and_dedupes() {
        assert_eq!(
            parse_category_list("social, promotional, social"),
            vec!["social".to_string(), "promotional".to_string()]
        );
    }

    #[test]
    fn label_mapping_handles_gmail_and_superhuman() {
        assert_eq!(label_to_category("Promotions"), Some(CATEGORY_PROMOTIONAL));
        assert_eq!(label_to_category("\\Spam"), Some(CATEGORY_SPAM));
        assert_eq!(
            label_to_category("[Superhuman]/AI/social"),
            Some(CATEGORY_SOCIAL)
        );
    }
}
