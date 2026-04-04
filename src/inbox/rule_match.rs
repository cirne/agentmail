//! Deterministic inbox rule evaluation (`rules.json` v2).

use async_trait::async_trait;
use regex::Regex;

use crate::inbox::scan::{
    inbox_fallback_pick, InboxBatchClassifier, InboxCandidate, InboxNotablePick,
};
use crate::rules::{parse_rule_action, RuleActionKind, RulesError, RulesFile, UserRule};

struct CompiledRegexRule {
    id: String,
    action: RuleActionKind,
    priority: i32,
    subject: Option<Regex>,
    body: Option<Regex>,
    from_pat: Option<Regex>,
    category: Option<Regex>,
    from_domain: Option<Regex>,
}

/// Compiled rules, sorted by priority then id.
pub struct CompiledRules {
    entries: Vec<CompiledRegexRule>,
}

impl CompiledRules {
    pub fn compile(file: &RulesFile) -> Result<Self, RulesError> {
        let mut entries: Vec<CompiledRegexRule> = Vec::new();
        for rule in &file.rules {
            let UserRule::Regex {
                id,
                action,
                priority,
                subject_pattern,
                body_pattern,
                from_pattern,
                category_pattern,
                from_domain_pattern,
                ..
            } = rule;
            let action = parse_rule_action(action)?;
            let subject = subject_pattern
                .as_ref()
                .filter(|s| !s.trim().is_empty())
                .map(|p| {
                    Regex::new(p).map_err(|e| RulesError::InvalidRegex {
                        id: id.clone(),
                        message: format!("subject: {e}"),
                    })
                })
                .transpose()?;
            let body = body_pattern
                .as_ref()
                .filter(|s| !s.trim().is_empty())
                .map(|p| {
                    Regex::new(p).map_err(|e| RulesError::InvalidRegex {
                        id: id.clone(),
                        message: format!("body: {e}"),
                    })
                })
                .transpose()?;
            let from_pat = from_pattern
                .as_ref()
                .filter(|s| !s.trim().is_empty())
                .map(|p| {
                    Regex::new(p).map_err(|e| RulesError::InvalidRegex {
                        id: id.clone(),
                        message: format!("from: {e}"),
                    })
                })
                .transpose()?;
            let category = category_pattern
                .as_ref()
                .filter(|s| !s.trim().is_empty())
                .map(|p| {
                    Regex::new(p).map_err(|e| RulesError::InvalidRegex {
                        id: id.clone(),
                        message: format!("category: {e}"),
                    })
                })
                .transpose()?;
            let from_domain = from_domain_pattern
                .as_ref()
                .filter(|s| !s.trim().is_empty())
                .map(|p| {
                    Regex::new(p).map_err(|e| RulesError::InvalidRegex {
                        id: id.clone(),
                        message: format!("fromDomain: {e}"),
                    })
                })
                .transpose()?;
            entries.push(CompiledRegexRule {
                id: id.clone(),
                action,
                priority: *priority,
                subject,
                body,
                from_pat,
                category,
                from_domain,
            });
        }
        entries.sort_by(|a, b| a.priority.cmp(&b.priority).then_with(|| a.id.cmp(&b.id)));
        Ok(Self { entries })
    }

    pub fn classify_one(&self, candidate: &InboxCandidate) -> InboxNotablePick {
        let mut matched_ids: Vec<String> = Vec::new();
        let mut best_action: Option<RuleActionKind> = None;
        for e in &self.entries {
            if regex_rule_matches(e, candidate) {
                matched_ids.push(e.id.clone());
                let a = e.action;
                best_action = Some(match best_action {
                    None => a,
                    Some(cur) => stronger_action(cur, a),
                });
            }
        }
        if matched_ids.is_empty() {
            return inbox_fallback_pick(candidate);
        }
        let action = best_action.unwrap_or(RuleActionKind::Inform);
        let action_s = match action {
            RuleActionKind::Notify => "notify",
            RuleActionKind::Inform => "inform",
            RuleActionKind::Ignore => "ignore",
        };
        InboxNotablePick {
            message_id: candidate.message_id.clone(),
            action: Some(action_s.to_string()),
            matched_rule_ids: matched_ids,
            note: None,
            decision_source: Some("rule".into()),
            requires_user_action: false,
            action_summary: None,
        }
    }
}

fn stronger_action(a: RuleActionKind, b: RuleActionKind) -> RuleActionKind {
    fn rank(x: RuleActionKind) -> u8 {
        match x {
            RuleActionKind::Notify => 3,
            RuleActionKind::Inform => 2,
            RuleActionKind::Ignore => 1,
        }
    }
    if rank(b) > rank(a) {
        b
    } else {
        a
    }
}

fn domain_from_address(addr: &str) -> Option<String> {
    let addr = addr.trim().to_ascii_lowercase();
    let at = addr.rfind('@')?;
    let dom = addr[at + 1..].trim();
    if dom.is_empty() {
        return None;
    }
    Some(dom.to_string())
}

fn regex_rule_matches(r: &CompiledRegexRule, c: &InboxCandidate) -> bool {
    let mut any = false;
    let mut all_ok = true;
    if let Some(re) = &r.category {
        any = true;
        match c.category.as_deref() {
            Some(cat) => all_ok = all_ok && re.is_match(cat),
            None => all_ok = false,
        }
    }
    if let Some(re) = &r.from_domain {
        any = true;
        let dm = domain_from_address(&c.from_address).unwrap_or_default();
        all_ok = all_ok && re.is_match(&dm);
    }
    if let Some(re) = &r.subject {
        any = true;
        all_ok = all_ok && re.is_match(&c.subject);
    }
    if let Some(re) = &r.body {
        any = true;
        all_ok = all_ok && re.is_match(&c.body_text);
    }
    if let Some(re) = &r.from_pat {
        any = true;
        all_ok = all_ok && re.is_match(&c.from_address);
    }
    any && all_ok
}

/// Deterministic classifier: no OpenAI.
pub struct DeterministicInboxClassifier {
    compiled: CompiledRules,
}

impl DeterministicInboxClassifier {
    pub fn new(rules: &RulesFile) -> Result<Self, RulesError> {
        Ok(Self {
            compiled: CompiledRules::compile(rules)?,
        })
    }
}

#[async_trait]
impl InboxBatchClassifier for DeterministicInboxClassifier {
    async fn classify_batch(
        &mut self,
        batch: Vec<InboxCandidate>,
    ) -> Result<Vec<InboxNotablePick>, crate::inbox::scan::RunInboxScanError> {
        Ok(batch
            .iter()
            .map(|c| self.compiled.classify_one(c))
            .collect())
    }
}

/// Classify one candidate without building a classifier (for tests / preview).
pub fn classify_candidate(
    rules: &RulesFile,
    c: &InboxCandidate,
) -> Result<InboxNotablePick, RulesError> {
    let compiled = CompiledRules::compile(rules)?;
    Ok(compiled.classify_one(c))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::{validate_rules_file, RulesFile, UserRule};

    fn candidate(body_text: &str, snippet: &str) -> InboxCandidate {
        candidate_from(body_text, snippet, "a@b.com")
    }

    fn candidate_from(body_text: &str, snippet: &str, from_address: &str) -> InboxCandidate {
        InboxCandidate {
            message_id: "m".into(),
            date: "2026-01-01".into(),
            from_address: from_address.into(),
            from_name: None,
            to_addresses: vec![],
            cc_addresses: vec![],
            subject: "s".into(),
            snippet: snippet.into(),
            body_text: body_text.into(),
            category: None,
            attachments: vec![],
        }
    }

    fn regex_from_only(id: &str, pat: &str) -> RulesFile {
        RulesFile {
            version: 2,
            rules: vec![UserRule::Regex {
                id: id.into(),
                action: "notify".into(),
                priority: 0,
                subject_pattern: None,
                body_pattern: None,
                from_pattern: Some(pat.into()),
                category_pattern: None,
                from_domain_pattern: None,
                description: None,
            }],
            context: vec![],
        }
    }

    #[test]
    fn body_regex_matches_full_body_not_snippet_prefix_only() {
        let rules = RulesFile {
            version: 2,
            rules: vec![UserRule::Regex {
                id: "r1".into(),
                action: "notify".into(),
                priority: 0,
                subject_pattern: None,
                body_pattern: Some("deep".into()),
                from_pattern: None,
                category_pattern: None,
                from_domain_pattern: None,
                description: None,
            }],
            context: vec![],
        };
        validate_rules_file(&rules).unwrap();
        let body = format!("{}deep", "x".repeat(300));
        let pick = classify_candidate(&rules, &candidate(&body, "short")).unwrap();
        assert_eq!(pick.action.as_deref(), Some("notify"));
        assert!(pick.matched_rule_ids.contains(&"r1".to_string()));
    }

    #[test]
    fn from_pattern_domain_suffix_matches() {
        let rules = regex_from_only("dom", r"@widgets\.example$");
        validate_rules_file(&rules).unwrap();
        let pick =
            classify_candidate(&rules, &candidate_from("b", "s", "alice@widgets.example")).unwrap();
        assert_eq!(pick.action.as_deref(), Some("notify"));
        assert!(pick.matched_rule_ids.contains(&"dom".to_string()));
    }

    #[test]
    fn from_pattern_exact_address_matches() {
        let rules = regex_from_only("exact", r"^billing@bank\.example$");
        validate_rules_file(&rules).unwrap();
        let hit =
            classify_candidate(&rules, &candidate_from("b", "s", "billing@bank.example")).unwrap();
        assert_eq!(hit.action.as_deref(), Some("notify"));
        let miss =
            classify_candidate(&rules, &candidate_from("b", "s", "other@bank.example")).unwrap();
        assert_ne!(miss.matched_rule_ids, hit.matched_rule_ids);
        assert!(!miss.matched_rule_ids.contains(&"exact".to_string()));
    }

    #[test]
    fn from_pattern_substring_anywhere_in_address() {
        let rules = regex_from_only("sub", "no-reply@");
        validate_rules_file(&rules).unwrap();
        let pick =
            classify_candidate(&rules, &candidate_from("b", "s", "No-Reply@Vendor.COM")).unwrap();
        assert!(
            pick.matched_rule_ids.is_empty(),
            "default match is case-sensitive on stored address"
        );
        let rules_ci = regex_from_only("subci", "(?i)no-reply@");
        validate_rules_file(&rules_ci).unwrap();
        let pick_ci =
            classify_candidate(&rules_ci, &candidate_from("b", "s", "No-Reply@Vendor.COM"))
                .unwrap();
        assert_eq!(pick_ci.action.as_deref(), Some("notify"));
    }

    #[test]
    fn from_pattern_does_not_match_display_name() {
        let rules = regex_from_only("addr_only", "Acme");
        validate_rules_file(&rules).unwrap();
        let mut c = candidate_from("b", "s", "x@y.com");
        c.from_name = Some("Acme Corp".into());
        let pick = classify_candidate(&rules, &c).unwrap();
        assert!(
            !pick.matched_rule_ids.contains(&"addr_only".to_string()),
            "from regex applies to from_address only"
        );
    }

    #[test]
    fn category_pattern_matches() {
        let rules = RulesFile {
            version: 2,
            rules: vec![UserRule::Regex {
                id: "cat1".into(),
                action: "ignore".into(),
                priority: 0,
                subject_pattern: None,
                body_pattern: None,
                from_pattern: None,
                category_pattern: Some("^list$".into()),
                from_domain_pattern: None,
                description: None,
            }],
            context: vec![],
        };
        validate_rules_file(&rules).unwrap();
        let mut c = candidate("b", "s");
        c.category = Some("list".into());
        let pick = classify_candidate(&rules, &c).unwrap();
        assert_eq!(pick.action.as_deref(), Some("ignore"));
        c.category = Some("personal".into());
        let miss = classify_candidate(&rules, &c).unwrap();
        assert!(miss.matched_rule_ids.is_empty());
    }
}
