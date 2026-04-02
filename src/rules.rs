//! File-backed inbox rules and context.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::inbox::scan::InboxOwnerContext;

pub const INBOX_RULES_PROMPT_VERSION: u32 = 5;

#[derive(Debug, thiserror::Error)]
pub enum RulesError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid action: {0}")]
    InvalidAction(String),
    #[error("missing update fields")]
    MissingUpdateFields,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RulesFile {
    #[serde(default = "default_rules_version")]
    pub version: u32,
    #[serde(default)]
    pub rules: Vec<UserRule>,
    #[serde(default)]
    pub context: Vec<ContextEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRule {
    pub id: String,
    pub condition: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextEntry {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleFeedbackProposal {
    pub proposed: ProposedRule,
    pub reasoning: String,
    pub apply: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedRule {
    pub condition: String,
    pub action: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuleActionKind {
    Notify,
    Inform,
    Ignore,
}

fn default_rules_version() -> u32 {
    1
}

pub fn rules_path(home: &Path) -> PathBuf {
    home.join("rules.json")
}

fn rules_lock_path(home: &Path) -> PathBuf {
    home.join("rules.lock")
}

pub fn parse_rule_action(action: &str) -> Result<RuleActionKind, RulesError> {
    let trimmed = action.trim();
    if trimmed.eq_ignore_ascii_case("notify") {
        return Ok(RuleActionKind::Notify);
    }
    if trimmed.eq_ignore_ascii_case("inform") {
        return Ok(RuleActionKind::Inform);
    }
    if trimmed.eq_ignore_ascii_case("ignore")
        || trimmed.eq_ignore_ascii_case("suppress")
        || trimmed.eq_ignore_ascii_case("archive")
    {
        return Ok(RuleActionKind::Ignore);
    }
    Err(RulesError::InvalidAction(trimmed.to_string()))
}

fn generate_id(existing_ids: impl Iterator<Item = String>) -> String {
    let existing: std::collections::HashSet<String> = existing_ids.collect();
    loop {
        let candidate = Uuid::new_v4()
            .simple()
            .to_string()
            .chars()
            .take(4)
            .collect::<String>();
        if !existing.contains(&candidate) {
            return candidate;
        }
    }
}

fn load_rules_file_from_path(path: &Path) -> Result<RulesFile, RulesError> {
    if !path.exists() {
        return Ok(RulesFile {
            version: default_rules_version(),
            ..Default::default()
        });
    }
    let raw = fs::read_to_string(path)?;
    let mut file: RulesFile = serde_json::from_str(&raw)?;
    if file.version == 0 {
        file.version = default_rules_version();
    }
    Ok(file)
}

pub fn load_rules_file(home: &Path) -> Result<RulesFile, RulesError> {
    load_rules_file_from_path(&rules_path(home))
}

fn lock_rules_file(home: &Path) -> Result<File, RulesError> {
    fs::create_dir_all(home)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(rules_lock_path(home))?;
    lock.lock_exclusive()?;
    Ok(lock)
}

fn write_rules_file_atomically(home: &Path, rules: &RulesFile) -> Result<(), RulesError> {
    fs::create_dir_all(home)?;
    let path = rules_path(home);
    let tmp_path = home.join(format!(
        ".rules.json.tmp.{}.{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    let raw = serde_json::to_string_pretty(rules)?;
    {
        let mut tmp = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp_path)?;
        tmp.write_all(format!("{raw}\n").as_bytes())?;
        tmp.sync_all()?;
    }
    fs::rename(&tmp_path, &path)?;
    if let Ok(dir) = File::open(home) {
        let _ = dir.sync_all();
    }
    Ok(())
}

fn with_locked_rules_file<T, F>(home: &Path, mutate: F) -> Result<T, RulesError>
where
    F: FnOnce(&mut RulesFile) -> Result<T, RulesError>,
{
    let lock = lock_rules_file(home)?;
    let path = rules_path(home);
    let mut file = load_rules_file_from_path(&path)?;
    let out = mutate(&mut file)?;
    write_rules_file_atomically(home, &file)?;
    lock.unlock()?;
    Ok(out)
}

pub fn save_rules_file(home: &Path, rules: &RulesFile) -> Result<(), RulesError> {
    let replacement = rules.clone();
    with_locked_rules_file(home, |file| {
        *file = replacement;
        Ok(())
    })
}

pub fn add_rule(home: &Path, action: &str, condition: &str) -> Result<UserRule, RulesError> {
    parse_rule_action(action)?;
    with_locked_rules_file(home, |file| {
        let id = generate_id(
            file.rules
                .iter()
                .map(|r| r.id.clone())
                .chain(file.context.iter().map(|c| c.id.clone())),
        );
        let rule = UserRule {
            id,
            condition: condition.trim().to_string(),
            action: action.trim().to_string(),
        };
        file.rules.push(rule.clone());
        Ok(rule)
    })
}

pub fn edit_rule(
    home: &Path,
    id: &str,
    condition: Option<&str>,
    action: Option<&str>,
) -> Result<Option<UserRule>, RulesError> {
    if condition.is_none() && action.is_none() {
        return Err(RulesError::MissingUpdateFields);
    }
    if let Some(a) = action {
        parse_rule_action(a)?;
    }
    with_locked_rules_file(home, |file| {
        let Some(rule) = file.rules.iter_mut().find(|rule| rule.id == id) else {
            return Ok(None);
        };
        if let Some(condition) = condition {
            rule.condition = condition.trim().to_string();
        }
        if let Some(action) = action {
            rule.action = action.trim().to_string();
        }
        Ok(Some(rule.clone()))
    })
}

pub fn remove_rule(home: &Path, id: &str) -> Result<Option<UserRule>, RulesError> {
    with_locked_rules_file(home, |file| {
        let Some(index) = file.rules.iter().position(|rule| rule.id == id) else {
            return Ok(None);
        };
        Ok(Some(file.rules.remove(index)))
    })
}

pub fn add_context(home: &Path, text: &str) -> Result<ContextEntry, RulesError> {
    with_locked_rules_file(home, |file| {
        let id = generate_id(
            file.rules
                .iter()
                .map(|r| r.id.clone())
                .chain(file.context.iter().map(|c| c.id.clone())),
        );
        let entry = ContextEntry {
            id,
            text: text.trim().to_string(),
        };
        file.context.push(entry.clone());
        Ok(entry)
    })
}

pub fn remove_context(home: &Path, id: &str) -> Result<Option<ContextEntry>, RulesError> {
    with_locked_rules_file(home, |file| {
        let Some(index) = file.context.iter().position(|entry| entry.id == id) else {
            return Ok(None);
        };
        Ok(Some(file.context.remove(index)))
    })
}

pub fn build_inbox_rules_prompt(
    file: &RulesFile,
    diagnostics: bool,
    owner: &InboxOwnerContext,
) -> String {
    let mut out = String::from(
        "You filter email for a user. Evaluate each message against the user's rules below.\n\
Return strict JSON:\n\
{\n\
  \"results\": [\n\
    {\n\
      \"messageId\": \"<exact id from input>\",\n\
      \"action\": \"notify|inform|ignore\",\n\
      \"matchedRuleIds\": [\"<rule id>\", \"<rule id>\"]\n\
    }\n\
  ]\n\
}\n\n\
For every message, return exactly one result row. Always populate matchedRuleIds; use [] when no explicit user rule matched.\n\
For messages not matching any rule, apply common-sense email triage:\n\
- Use `notify` only for messages that are interruption-worthy right now: OTP codes, active security issues, same-day deadlines, or urgent direct asks that should break the user's flow.\n\
- Use `inform` only for messages worth surfacing at the next inbox review: mostly human-to-human mail, important work updates, non-urgent requests, and things the user would reasonably want summarized soon.\n\
- Use `ignore` for mail that is legitimate and searchable but should not get proactive surfacing: receipts, confirmations, bulk updates, marketing, digests, and obvious low-priority automation.\n\
Automated mail should usually NOT be `inform` unless the user has explicitly asked for it with a rule. Newsletters, mailing-list traffic, marketing, social notifications, digest emails, recommendations, deal alerts, automated invitations, and most no-reply senders should be `ignore`, not `inform`.\n\
Default to `ignore` when a message seems legitimate but not clearly worth surfacing. When unsure between `notify` and `inform`, prefer `inform`. When unsure between `inform` and `ignore`, prefer `ignore`.\n\
If a message is effectively from the user, sent by the user, or uses one of the user's own addresses as sender or reply identity, do not `notify`. Usually choose `ignore` unless the user's rules say otherwise.\n\n",
    );
    out.push_str("## User Identity:\n");
    match &owner.primary_address {
        Some(primary) => out.push_str(&format!("- Primary email: {primary}\n")),
        None => out.push_str("- Primary email: unknown\n"),
    }
    match &owner.display_name {
        Some(name) => out.push_str(&format!("- User name: {name}\n")),
        None => out.push_str("- User name: unknown\n"),
    }
    if owner.alias_addresses.is_empty() {
        out.push_str("- Email aliases: none configured\n\n");
    } else {
        out.push_str(&format!(
            "- Email aliases: {}\n\n",
            owner.alias_addresses.join(", ")
        ));
    }
    if diagnostics {
        out.push_str(
            "When helpful for diagnostics, you may also include an optional `note` field with one short line why.\n\n",
        );
    }
    append_rule_group(&mut out, "NOTIFY", file, |action| {
        matches!(parse_rule_action(action), Ok(RuleActionKind::Notify))
    });
    append_rule_group(&mut out, "INFORM", file, |action| {
        matches!(parse_rule_action(action), Ok(RuleActionKind::Inform))
    });
    append_rule_group(&mut out, "IGNORE", file, |action| {
        matches!(parse_rule_action(action), Ok(RuleActionKind::Ignore))
    });

    out.push_str("## Context:\n");
    if file.context.is_empty() {
        out.push_str("- None\n");
    } else {
        for entry in &file.context {
            out.push_str(&format!("- {}\n", entry.text));
        }
    }
    out
}

pub fn rules_fingerprint(file: &RulesFile) -> String {
    let mut rules = file.rules.clone();
    rules.sort_by(|a, b| {
        a.id.cmp(&b.id)
            .then_with(|| a.condition.cmp(&b.condition))
            .then_with(|| a.action.cmp(&b.action))
    });
    let mut context = file.context.clone();
    context.sort_by(|a, b| a.id.cmp(&b.id).then_with(|| a.text.cmp(&b.text)));
    let normalized = serde_json::json!({
        "version": file.version,
        "promptVersion": INBOX_RULES_PROMPT_VERSION,
        "rules": rules,
        "context": context,
    });
    let mut hasher = Sha256::new();
    hasher.update(normalized.to_string().as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn append_rule_group<F>(out: &mut String, title: &str, file: &RulesFile, matcher: F)
where
    F: Fn(&str) -> bool,
{
    out.push_str(&format!("## {title}:\n"));
    let mut any = false;
    for rule in &file.rules {
        if !matcher(&rule.action) {
            continue;
        }
        any = true;
        out.push_str(&format!("[{}] {}\n", rule.id, render_rule(rule)));
    }
    if !any {
        out.push_str("- None\n");
    }
    out.push('\n');
}

fn render_rule(rule: &UserRule) -> String {
    rule.condition.clone()
}

pub fn propose_rule_from_feedback(feedback: &str) -> RuleFeedbackProposal {
    let normalized = feedback.trim();
    let lower = normalized.to_ascii_lowercase();
    let (condition, action, reasoning) = if lower.contains("shipping")
        || lower.contains("tracking")
        || lower.contains("delivery")
    {
        (
                "routine shipping and tracking updates unless delivery is scheduled for today or tomorrow".to_string(),
                "ignore".to_string(),
                "Shipping notifications are usually low urgency except when delivery is imminent, so ignore the routine updates while preserving time-sensitive alerts.".to_string(),
            )
    } else if lower.contains("invoice")
        || lower.contains("receipt")
        || lower.contains("billing")
        || lower.contains("statement")
    {
        (
            "invoices, receipts, or billing statements".to_string(),
            "ignore".to_string(),
            "Financial paperwork is often useful later but rarely urgent, so ignore it instead of surfacing it as notable mail.".to_string(),
        )
    } else if lower.contains("flight")
        || lower.contains("hotel")
        || lower.contains("travel")
        || lower.contains("itinerary")
    {
        (
            "flight confirmations, hotel bookings, and travel itineraries".to_string(),
            "ignore".to_string(),
            "Travel confirmations are often useful later but usually do not need inbox attention, so ignore them for later search.".to_string(),
        )
    } else if lower.contains("security")
        || lower.contains("fraud")
        || lower.contains("bank")
        || lower.contains("alert")
    {
        (
                normalized.to_string(),
                "notify".to_string(),
                "Security and financial alerts should bypass normal filtering because they are usually urgent.".to_string(),
            )
    } else {
        let action = "ignore".to_string();
        (
            normalized.to_string(),
            action.clone(),
            format!(
                "Converted the free-form feedback into a structured inbox rule using a {} action.",
                action
            ),
        )
    };
    RuleFeedbackProposal {
        proposed: ProposedRule {
            condition: condition.clone(),
            action: action.clone(),
        },
        reasoning,
        apply: format!(
            "zmail rules add --action {} \"{}\"",
            action,
            condition.replace('"', "\\\"")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_parser_rejects_tag() {
        assert!(parse_rule_action("tag:travel").is_err());
    }

    #[test]
    fn action_parser_accepts_notify_and_inform() {
        assert_eq!(parse_rule_action("notify").unwrap(), RuleActionKind::Notify);
        assert_eq!(parse_rule_action("inform").unwrap(), RuleActionKind::Inform);
    }

    #[test]
    fn missing_file_loads_default_rules() {
        let dir = tempfile::tempdir().unwrap();
        let file = load_rules_file(dir.path()).unwrap();
        assert_eq!(file.version, 1);
        assert!(file.rules.is_empty());
        assert!(file.context.is_empty());
    }

    #[test]
    fn feedback_shipping_maps_to_ignore_rule() {
        let proposal = propose_rule_from_feedback("too many shipping notifications");
        assert_eq!(proposal.proposed.action, "ignore");
        assert!(proposal.proposed.condition.contains("shipping"));
    }

    #[test]
    fn save_rules_file_creates_lock_and_json() {
        let dir = tempfile::tempdir().unwrap();
        let rules = RulesFile {
            version: 1,
            rules: vec![UserRule {
                id: "a1b2".into(),
                condition: "promo email".into(),
                action: "ignore".into(),
            }],
            context: vec![],
        };
        save_rules_file(dir.path(), &rules).unwrap();
        assert!(rules_path(dir.path()).exists());
        assert!(rules_lock_path(dir.path()).exists());
        let loaded = load_rules_file(dir.path()).unwrap();
        assert_eq!(loaded.rules.len(), 1);
    }

    #[test]
    fn rules_fingerprint_is_stable_for_reordered_entries() {
        let a = RulesFile {
            version: 1,
            rules: vec![
                UserRule {
                    id: "b".into(),
                    condition: "beta".into(),
                    action: "ignore".into(),
                },
                UserRule {
                    id: "a".into(),
                    condition: "alpha".into(),
                    action: "inform".into(),
                },
            ],
            context: vec![
                ContextEntry {
                    id: "2".into(),
                    text: "later".into(),
                },
                ContextEntry {
                    id: "1".into(),
                    text: "earlier".into(),
                },
            ],
        };
        let b = RulesFile {
            version: 1,
            rules: vec![a.rules[1].clone(), a.rules[0].clone()],
            context: vec![a.context[1].clone(), a.context[0].clone()],
        };
        assert_eq!(rules_fingerprint(&a), rules_fingerprint(&b));
    }

    #[test]
    fn rules_fingerprint_changes_when_rules_change() {
        let a = RulesFile {
            version: 1,
            rules: vec![UserRule {
                id: "a".into(),
                condition: "promo".into(),
                action: "ignore".into(),
            }],
            context: vec![],
        };
        let mut b = a.clone();
        b.rules[0].action = "notify".into();
        assert_ne!(rules_fingerprint(&a), rules_fingerprint(&b));
    }

    #[test]
    fn inbox_rules_prompt_omits_note_without_diagnostics() {
        let prompt =
            build_inbox_rules_prompt(&RulesFile::default(), false, &InboxOwnerContext::default());
        assert!(!prompt.contains("\"note\""));
    }

    #[test]
    fn inbox_rules_prompt_mentions_optional_note_with_diagnostics() {
        let prompt =
            build_inbox_rules_prompt(&RulesFile::default(), true, &InboxOwnerContext::default());
        assert!(prompt.contains("optional `note` field"));
        assert!(prompt.contains("\"action\": \"notify|inform|ignore\""));
        assert!(prompt.contains("Default to `ignore`"));
    }

    #[test]
    fn inbox_rules_prompt_includes_owner_identity_and_self_mail_guidance() {
        let owner = InboxOwnerContext {
            primary_address: Some("lewiscirne@gmail.com".into()),
            alias_addresses: vec!["lewiscirne@mac.com".into()],
            display_name: Some("Lewis Cirne".into()),
        };
        let prompt = build_inbox_rules_prompt(&RulesFile::default(), false, &owner);
        assert!(prompt.contains("Primary email: lewiscirne@gmail.com"));
        assert!(prompt.contains("Email aliases: lewiscirne@mac.com"));
        assert!(prompt.contains("If a message is effectively from the user"));
    }
}
