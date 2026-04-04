//! File-backed inbox rules (v2: regex rules only).
//! Legacy `context` entries in JSON are ignored by the inbox matcher and kept for file round-trip.

use std::collections::HashSet;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Bundled defaults when `rules.json` is missing (`zmail inbox` / first load).
pub const DEFAULT_RULES_JSON: &str = include_str!("rules/default_rules.v2.json");

/// Max length for each regex pattern in a `regex` rule (compile-time guard).
pub const MAX_REGEX_PATTERN_LEN: usize = 512;

#[derive(thiserror::Error)]
pub enum RulesError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid action: {0}")]
    InvalidAction(String),
    #[error("missing update fields")]
    MissingUpdateFields,
    #[error("duplicate rule id: {0}")]
    DuplicateRuleId(String),
    #[error("invalid regex for rule {id}: {message}")]
    InvalidRegex { id: String, message: String },
    #[error("regex rule {id} needs at least one matcher (subject, body, from, categoryPattern, or fromDomainPattern)")]
    EmptyRegex { id: String },
    #[error("invalid rules file: {0}")]
    InvalidRules(String),
    /// Existing file on disk cannot be parsed as rules v2 (legacy v1, corrupt JSON, etc.).
    #[error(
        "rules file is unusable: {}\n\n{}\n\nReplace with bundled defaults (current file is renamed to rules.json.bak.<uuid> in the same directory):\n  zmail rules reset-defaults --yes\n\nOr migrate by hand to v2 rules (each rule has \"kind\": \"regex\"). An agent/LLM can rewrite the file from your intent; doc: skills/zmail/references/INBOX-CUSTOMIZATION.md in the zmail repo.",
        path.display(),
        detail
    )]
    UnusableRulesFile { path: PathBuf, detail: String },
}

impl fmt::Debug for RulesError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
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

/// Inbox rule: `kind` is **`regex`**. Matchers are regex on subject, body, from address,
/// **category** (`categoryPattern`), or sender **domain** (`fromDomainPattern`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UserRule {
    #[serde(rename = "regex")]
    Regex {
        id: String,
        action: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "subjectPattern"
        )]
        subject_pattern: Option<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "bodyPattern"
        )]
        body_pattern: Option<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "fromPattern"
        )]
        from_pattern: Option<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "categoryPattern"
        )]
        category_pattern: Option<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            rename = "fromDomainPattern"
        )]
        from_domain_pattern: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
}

impl UserRule {
    pub fn id(&self) -> &str {
        match self {
            UserRule::Regex { id, .. } => id.as_str(),
        }
    }

    pub fn action_str(&self) -> &str {
        match self {
            UserRule::Regex { action, .. } => action.as_str(),
        }
    }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleActionKind {
    Notify,
    Inform,
    Ignore,
}

fn default_rules_version() -> u32 {
    2
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
    let existing: HashSet<String> = existing_ids.collect();
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

/// Write bundled defaults if `rules.json` does not exist (idempotent).
pub fn ensure_default_rules_file(home: &Path) -> Result<(), RulesError> {
    let path = rules_path(home);
    if path.exists() {
        return Ok(());
    }
    fs::create_dir_all(home)?;
    let file: RulesFile = serde_json::from_str(DEFAULT_RULES_JSON)?;
    write_rules_file_atomically(home, &file)?;
    Ok(())
}

fn reject_snippet_pattern_key(raw: &str, path: &Path) -> Result<(), RulesError> {
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| diagnose_rules_parse_failure(path, raw, e))?;
    if let Some(rules) = v.get("rules").and_then(|r| r.as_array()) {
        for (i, rule) in rules.iter().enumerate() {
            if rule.get("snippetPattern").is_some() {
                return Err(RulesError::InvalidRules(format!(
                    "rules[{i}]: \"snippetPattern\" is not supported; use \"bodyPattern\""
                )));
            }
        }
    }
    Ok(())
}

/// Parse `rules.json` body from disk; on failure, classify legacy v1 / corrupt JSON for CLI messages.
pub(crate) fn parse_rules_file_str(raw: &str, path: &Path) -> Result<RulesFile, RulesError> {
    reject_snippet_pattern_key(raw, path)?;
    let mut file: RulesFile = match serde_json::from_str(raw) {
        Ok(f) => f,
        Err(e) => return Err(diagnose_rules_parse_failure(path, raw, e)),
    };
    if file.version == 0 {
        file.version = default_rules_version();
    }
    validate_rules_file(&file)?;
    Ok(file)
}

fn diagnose_rules_parse_failure(path: &Path, raw: &str, e: serde_json::Error) -> RulesError {
    let mut detail = format!("{e}");
    let es = e.to_string();
    if es.contains("missing field `kind`") {
        detail = "Expected each rule to include \"kind\": \"regex\". \
                  Older zmail used version 1 with a free-text \"condition\" field — that format is no longer loaded."
            .to_string();
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
        if v.get("version").and_then(|x| x.as_u64()) == Some(1) {
            detail = "\"version\": 1 is no longer supported. zmail requires rules.json version 2 with typed rules (\"kind\" on every rule)."
                .to_string();
        } else if let Some(rules) = v.get("rules").and_then(|r| r.as_array()) {
            for (i, rule) in rules.iter().enumerate() {
                let obj = rule.as_object();
                let missing_kind = obj.is_some_and(|o| !o.contains_key("kind"));
                let looks_legacy = obj.is_some_and(|o| o.contains_key("condition"));
                if missing_kind && looks_legacy {
                    detail = format!(
                        "rules[{i}] looks like a legacy rule (has \"condition\" but no \"kind\"). Convert to a typed rule or run `zmail rules reset-defaults --yes`."
                    );
                    break;
                }
            }
        }
    }
    RulesError::UnusableRulesFile {
        path: path.to_path_buf(),
        detail,
    }
}

pub(crate) fn load_rules_file_from_path(path: &Path) -> Result<RulesFile, RulesError> {
    if !path.exists() {
        return Ok(RulesFile {
            version: default_rules_version(),
            ..Default::default()
        });
    }
    let raw = fs::read_to_string(path)?;
    parse_rules_file_str(&raw, path)
}

/// Replace `rules.json` with bundled defaults. If a file already exists, rename it to `rules.json.bak.<uuid>`.
pub fn reset_rules_to_bundled_defaults(home: &Path) -> Result<Option<PathBuf>, RulesError> {
    fs::create_dir_all(home)?;
    let path = rules_path(home);
    let backup = if path.exists() {
        let bak = home.join(format!("rules.json.bak.{}", Uuid::new_v4().simple()));
        fs::rename(&path, &bak)?;
        Some(bak)
    } else {
        None
    };
    let file: RulesFile = serde_json::from_str(DEFAULT_RULES_JSON)?;
    write_rules_file_atomically(home, &file)?;
    Ok(backup)
}

pub fn load_rules_file(home: &Path) -> Result<RulesFile, RulesError> {
    ensure_default_rules_file(home)?;
    load_rules_file_from_path(&rules_path(home))
}

/// Validate rules (duplicate ids, regex compile, at least one matcher per rule).
pub fn validate_rules_file(file: &RulesFile) -> Result<(), RulesError> {
    let mut seen = HashSet::new();
    for rule in &file.rules {
        let id = rule.id().to_string();
        if !seen.insert(id.clone()) {
            return Err(RulesError::DuplicateRuleId(id));
        }
        parse_rule_action(rule.action_str())?;
        let UserRule::Regex {
            subject_pattern,
            body_pattern,
            from_pattern,
            category_pattern,
            from_domain_pattern,
            id,
            ..
        } = rule;
        if subject_pattern.as_ref().is_none_or(|s| s.trim().is_empty())
            && body_pattern.as_ref().is_none_or(|s| s.trim().is_empty())
            && from_pattern.as_ref().is_none_or(|s| s.trim().is_empty())
            && category_pattern
                .as_ref()
                .is_none_or(|s| s.trim().is_empty())
            && from_domain_pattern
                .as_ref()
                .is_none_or(|s| s.trim().is_empty())
        {
            return Err(RulesError::EmptyRegex { id: id.clone() });
        }
        for (label, pat) in [
            ("subject", subject_pattern.as_deref()),
            ("body", body_pattern.as_deref()),
            ("from", from_pattern.as_deref()),
            ("category", category_pattern.as_deref()),
            ("fromDomain", from_domain_pattern.as_deref()),
        ] {
            if let Some(p) = pat.filter(|s| !s.trim().is_empty()) {
                if p.len() > MAX_REGEX_PATTERN_LEN {
                    return Err(RulesError::InvalidRegex {
                        id: id.clone(),
                        message: format!("{label} pattern too long (max {MAX_REGEX_PATTERN_LEN})"),
                    });
                }
                regex::Regex::new(p).map_err(|e| RulesError::InvalidRegex {
                    id: id.clone(),
                    message: format!("{label}: {e}"),
                })?;
            }
        }
    }
    Ok(())
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
    validate_rules_file(rules)?;
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
    let mut file = if path.exists() {
        let raw = fs::read_to_string(&path)?;
        parse_rules_file_str(&raw, &path)?
    } else {
        RulesFile {
            version: default_rules_version(),
            ..Default::default()
        }
    };
    validate_rules_file(&file)?;
    let out = mutate(&mut file)?;
    validate_rules_file(&file)?;
    write_rules_file_atomically(home, &file)?;
    lock.unlock()?;
    Ok(out)
}

pub fn save_rules_file(home: &Path, rules: &RulesFile) -> Result<(), RulesError> {
    let replacement = rules.clone();
    validate_rules_file(&replacement)?;
    with_locked_rules_file(home, |file| {
        *file = replacement;
        Ok(())
    })
}

fn trim_opt_owned(s: Option<String>) -> Option<String> {
    s.and_then(|t| {
        let t = t.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    })
}

/// Append a rule (at least one of subject/body/from/categoryPattern/fromDomainPattern), or insert
/// before an existing rule id when `insert_before` is set.
#[allow(clippy::too_many_arguments)]
pub fn add_regex_rule(
    home: &Path,
    action: &str,
    subject_pattern: Option<String>,
    body_pattern: Option<String>,
    from_pattern: Option<String>,
    category_pattern: Option<String>,
    from_domain_pattern: Option<String>,
    description: Option<String>,
    insert_before: Option<&str>,
) -> Result<UserRule, RulesError> {
    parse_rule_action(action)?;
    let subject_pattern = trim_opt_owned(subject_pattern);
    let body_pattern = trim_opt_owned(body_pattern);
    let from_pattern = trim_opt_owned(from_pattern);
    let category_pattern = trim_opt_owned(category_pattern);
    let from_domain_pattern = trim_opt_owned(from_domain_pattern);
    let description = trim_opt_owned(description);
    if subject_pattern.is_none()
        && body_pattern.is_none()
        && from_pattern.is_none()
        && category_pattern.is_none()
        && from_domain_pattern.is_none()
    {
        return Err(RulesError::InvalidRules(
            "regex rule needs at least one matcher (--subject-pattern, --body-pattern, --from-pattern, or edit rules.json for categoryPattern/fromDomainPattern)"
                .into(),
        ));
    }
    with_locked_rules_file(home, |file| {
        file.version = file.version.max(default_rules_version());
        let id = generate_id(
            file.rules
                .iter()
                .map(|r| r.id().to_string())
                .chain(file.context.iter().map(|c| c.id.clone())),
        );
        let rule = UserRule::Regex {
            id,
            action: action.trim().to_string(),
            subject_pattern,
            body_pattern,
            from_pattern,
            category_pattern,
            from_domain_pattern,
            description,
        };
        if let Some(before_id) = insert_before.map(str::trim).filter(|s| !s.is_empty()) {
            let Some(idx) = file.rules.iter().position(|r| r.id() == before_id) else {
                return Err(RulesError::InvalidRules(format!(
                    "insert-before: no rule with id {before_id:?}"
                )));
            };
            file.rules.insert(idx, rule.clone());
        } else {
            file.rules.push(rule.clone());
        }
        Ok(rule)
    })
}

pub fn add_rule_from_json(
    home: &Path,
    json_rule: &str,
    insert_before: Option<&str>,
) -> Result<UserRule, RulesError> {
    let v: serde_json::Value = serde_json::from_str(json_rule)
        .map_err(|e| RulesError::InvalidRules(format!("invalid rule JSON: {e}")))?;
    if v.get("snippetPattern").is_some() {
        return Err(RulesError::InvalidRules(
            "\"snippetPattern\" is not supported; use \"bodyPattern\"".into(),
        ));
    }
    let mut rule: UserRule = serde_json::from_value(v)
        .map_err(|e| RulesError::InvalidRules(format!("invalid rule JSON: {e}")))?;
    with_locked_rules_file(home, |file| {
        file.version = file.version.max(default_rules_version());
        let id = generate_id(
            file.rules
                .iter()
                .map(|r| r.id().to_string())
                .chain(file.context.iter().map(|c| c.id.clone())),
        );
        let UserRule::Regex { id: rid, .. } = &mut rule;
        rid.clear();
        rid.push_str(&id);
        if let Some(before_id) = insert_before.map(str::trim).filter(|s| !s.is_empty()) {
            let Some(idx) = file.rules.iter().position(|r| r.id() == before_id) else {
                return Err(RulesError::InvalidRules(format!(
                    "insert-before: no rule with id {before_id:?}"
                )));
            };
            file.rules.insert(idx, rule.clone());
        } else {
            file.rules.push(rule.clone());
        }
        Ok(rule)
    })
}

pub fn edit_rule(
    home: &Path,
    id: &str,
    action: Option<&str>,
) -> Result<Option<UserRule>, RulesError> {
    if action.is_none() {
        return Err(RulesError::MissingUpdateFields);
    }
    if let Some(a) = action {
        parse_rule_action(a)?;
    }
    with_locked_rules_file(home, |file| {
        let Some(rule) = file.rules.iter_mut().find(|rule| rule.id() == id) else {
            return Ok(None);
        };
        if let Some(action) = action {
            let UserRule::Regex { action: ra, .. } = rule;
            *ra = action.trim().to_string();
        }
        Ok(Some(rule.clone()))
    })
}

pub fn remove_rule(home: &Path, id: &str) -> Result<Option<UserRule>, RulesError> {
    with_locked_rules_file(home, |file| {
        let Some(index) = file.rules.iter().position(|rule| rule.id() == id) else {
            return Ok(None);
        };
        Ok(Some(file.rules.remove(index)))
    })
}

/// Move rule `id` relative to another rule: exactly one of `insert_before` / `insert_after` must be set
/// (the other `None`). Higher precedence = earlier in the list.
pub fn move_rule(
    home: &Path,
    id: &str,
    insert_before: Option<&str>,
    insert_after: Option<&str>,
) -> Result<Option<UserRule>, RulesError> {
    let before = insert_before.map(str::trim).filter(|s| !s.is_empty());
    let after = insert_after.map(str::trim).filter(|s| !s.is_empty());
    let (anchor_id, place_before) = match (before, after) {
        (None, None) => {
            return Err(RulesError::InvalidRules(
                "move rule: pass exactly one of --before or --after".into(),
            ));
        }
        (Some(_), Some(_)) => {
            return Err(RulesError::InvalidRules(
                "move rule: pass only one of --before or --after".into(),
            ));
        }
        (Some(b), None) => (b, true),
        (None, Some(a)) => (a, false),
    };

    with_locked_rules_file(home, |file| {
        let Some(from_idx) = file.rules.iter().position(|r| r.id() == id) else {
            return Ok(None);
        };
        if anchor_id == id {
            return Err(RulesError::InvalidRules(
                "move rule: cannot move relative to itself".into(),
            ));
        }
        let Some(anchor_idx) = file.rules.iter().position(|r| r.id() == anchor_id) else {
            return Err(RulesError::InvalidRules(format!(
                "move rule: no rule with id {anchor_id:?}"
            )));
        };
        let rule = file.rules.remove(from_idx);
        let mut anchor_idx_after = anchor_idx;
        if from_idx < anchor_idx {
            anchor_idx_after -= 1;
        }
        let insert_idx = if place_before {
            anchor_idx_after
        } else {
            anchor_idx_after + 1
        };
        file.rules.insert(insert_idx, rule);
        Ok(Some(file.rules[insert_idx].clone()))
    })
}

pub fn rules_fingerprint(file: &RulesFile) -> String {
    let rules_json: Vec<serde_json::Value> = file
        .rules
        .iter()
        .map(|r| serde_json::to_value(r).unwrap_or(serde_json::Value::Null))
        .collect();
    let mut context = file.context.clone();
    context.sort_by(|a, b| a.id.cmp(&b.id).then_with(|| a.text.cmp(&b.text)));
    let normalized = serde_json::json!({
        "version": file.version,
        "rules": rules_json,
        "context": context,
    });
    let mut hasher = Sha256::new();
    hasher.update(normalized.to_string().as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn propose_rule_from_feedback(feedback: &str) -> RuleFeedbackProposal {
    let normalized = feedback.trim();
    let lower = normalized.to_ascii_lowercase();
    let (condition, action, reasoning) = if lower.contains("shipping")
        || lower.contains("tracking")
        || lower.contains("delivery")
    {
        (
            "marketingSnippet or from-pattern / subject regex for shipping senders".to_string(),
            "ignore".to_string(),
            "Add a regex on body, subject, or sender address (--from-pattern), or categoryPattern/fromDomainPattern in rules.json."
                .to_string(),
        )
    } else if lower.contains("invoice")
        || lower.contains("receipt")
        || lower.contains("billing")
        || lower.contains("statement")
    {
        (
            "from-pattern or subject regex for billing senders".to_string(),
            "ignore".to_string(),
            "Encode with a typed rule in rules.json (see zmail rules validate).".to_string(),
        )
    } else if lower.contains("flight")
        || lower.contains("hotel")
        || lower.contains("travel")
        || lower.contains("itinerary")
    {
        (
            "regex on subject for travel keywords".to_string(),
            "inform".to_string(),
            "Travel mail is often time-sensitive; use a notify or inform regex rule.".to_string(),
        )
    } else if lower.contains("security")
        || lower.contains("fraud")
        || lower.contains("bank")
        || lower.contains("alert")
    {
        (
            "regex def-otp-style patterns".to_string(),
            "notify".to_string(),
            "Security alerts should use notify; extend default OTP regex rules if needed."
                .to_string(),
        )
    } else {
        let action = "ignore".to_string();
        (
            normalized.to_string(),
            action.clone(),
            "Edit ~/.zmail/rules.json (regex rules only); run zmail rules validate.".to_string(),
        )
    };
    RuleFeedbackProposal {
        proposed: ProposedRule {
            condition: condition.clone(),
            action: action.clone(),
        },
        reasoning,
        apply: "Use `zmail rules add` with typed flags (see `zmail rules add --help`), or `zmail rules reset-defaults --yes` if the file is legacy/corrupt, or edit ~/.zmail/rules.json by hand / with an agent."
            .to_string(),
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
    fn missing_file_after_ensure_loads_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let file = load_rules_file(dir.path()).unwrap();
        assert_eq!(file.version, 2);
        assert!(!file.rules.is_empty());
        assert!(file.context.is_empty());
    }

    #[test]
    fn default_rules_json_validates() {
        let file: RulesFile = serde_json::from_str(DEFAULT_RULES_JSON).unwrap();
        validate_rules_file(&file).unwrap();
    }

    #[test]
    fn rules_json_snippet_pattern_rejected() {
        use std::fs;
        let json = r#"{"version":2,"rules":[{"kind":"regex","id":"x","action":"ignore","snippetPattern":"(?i)foo"}],"context":[]}"#;
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path()).unwrap();
        let path = rules_path(dir.path());
        fs::write(&path, json).unwrap();
        let err = load_rules_file_from_path(&path).unwrap_err();
        let s = err.to_string();
        assert!(
            s.contains("snippetPattern") && s.contains("bodyPattern"),
            "{s}"
        );
    }

    #[test]
    fn save_rules_file_creates_lock_and_json() {
        let dir = tempfile::tempdir().unwrap();
        let rules = serde_json::from_str::<RulesFile>(DEFAULT_RULES_JSON).unwrap();
        save_rules_file(dir.path(), &rules).unwrap();
        assert!(rules_path(dir.path()).exists());
        let loaded = load_rules_file_from_path(&rules_path(dir.path())).unwrap();
        assert_eq!(loaded.rules.len(), rules.rules.len());
    }

    #[test]
    fn rules_fingerprint_changes_when_rule_order_changes() {
        let a: RulesFile = serde_json::from_str(DEFAULT_RULES_JSON).unwrap();
        let mut b = a.clone();
        b.rules.reverse();
        assert_ne!(rules_fingerprint(&a), rules_fingerprint(&b));
    }

    #[test]
    fn rules_fingerprint_changes_when_action_changes() {
        let a: RulesFile = serde_json::from_str(DEFAULT_RULES_JSON).unwrap();
        let mut b = a.clone();
        let target = b
            .rules
            .iter_mut()
            .find(|r| r.action_str() == "ignore")
            .expect("defaults include at least one ignore rule");
        let UserRule::Regex { action, .. } = target;
        *action = "inform".into();
        assert_ne!(rules_fingerprint(&a), rules_fingerprint(&b));
    }

    #[test]
    fn add_regex_rule_category_pattern_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let _ = load_rules_file(dir.path()).unwrap();
        let rule = add_regex_rule(
            dir.path(),
            "inform",
            None,
            None,
            None,
            Some(r"(?i)^promotions$".into()),
            None,
            Some("Promo bucket".into()),
            None,
        )
        .unwrap();
        assert_eq!(rule.action_str(), "inform");
        let loaded = load_rules_file_from_path(&rules_path(dir.path())).unwrap();
        assert!(loaded.rules.iter().any(|r| {
            matches!(r, UserRule::Regex { category_pattern, .. } if category_pattern.as_deref() == Some("(?i)^promotions$"))
        }));
    }

    #[test]
    fn add_regex_rule_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let _ = load_rules_file(dir.path()).unwrap();
        let rule = add_regex_rule(
            dir.path(),
            "ignore",
            Some(r"(?i)newsletter".into()),
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(rule.action_str(), "ignore");
        let loaded = load_rules_file_from_path(&rules_path(dir.path())).unwrap();
        assert!(loaded.rules.iter().any(|r| {
            matches!(r, UserRule::Regex { subject_pattern, .. } if subject_pattern.as_deref() == Some("(?i)newsletter"))
        }));
    }

    #[test]
    fn add_regex_rule_from_pattern_only_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let _ = load_rules_file(dir.path()).unwrap();
        let rule = add_regex_rule(
            dir.path(),
            "notify",
            None,
            None,
            Some(r"@acme\.test".into()),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(rule.action_str(), "notify");
        let loaded = load_rules_file_from_path(&rules_path(dir.path())).unwrap();
        assert!(loaded.rules.iter().any(|r| {
            matches!(r, UserRule::Regex { from_pattern, .. } if from_pattern.as_deref() == Some(r"@acme\.test"))
        }));
    }

    #[test]
    fn add_regex_rule_insert_before_places_rule_first() {
        let dir = tempfile::tempdir().unwrap();
        let _ = load_rules_file(dir.path()).unwrap();
        let loaded_before = load_rules_file_from_path(&rules_path(dir.path())).unwrap();
        let first_id = loaded_before.rules[0].id().to_string();
        let rule = add_regex_rule(
            dir.path(),
            "inform",
            Some(r"(?i)insert-test".into()),
            None,
            None,
            None,
            None,
            None,
            Some(&first_id),
        )
        .unwrap();
        let loaded = load_rules_file_from_path(&rules_path(dir.path())).unwrap();
        assert_eq!(loaded.rules[0].id(), rule.id());
        assert_eq!(loaded.rules[1].id(), first_id.as_str());
    }

    #[test]
    fn add_regex_rule_insert_before_unknown_id_errors() {
        let dir = tempfile::tempdir().unwrap();
        let _ = load_rules_file(dir.path()).unwrap();
        let err = add_regex_rule(
            dir.path(),
            "inform",
            Some(r"(?i)x".into()),
            None,
            None,
            None,
            None,
            None,
            Some("no-such-id"),
        )
        .unwrap_err();
        assert!(err.to_string().contains("insert-before"));
    }

    #[test]
    fn move_rule_before_works() {
        let dir = tempfile::tempdir().unwrap();
        let _ = load_rules_file(dir.path()).unwrap();
        let loaded = load_rules_file_from_path(&rules_path(dir.path())).unwrap();
        let a = loaded.rules[0].id().to_string();
        let b = loaded.rules[1].id().to_string();
        move_rule(dir.path(), &b, Some(&a), None).unwrap();
        let loaded = load_rules_file_from_path(&rules_path(dir.path())).unwrap();
        assert_eq!(loaded.rules[0].id(), b);
        assert_eq!(loaded.rules[1].id(), a);
    }

    #[test]
    fn move_rule_after_last_appends() {
        let dir = tempfile::tempdir().unwrap();
        let _ = load_rules_file(dir.path()).unwrap();
        let loaded = load_rules_file_from_path(&rules_path(dir.path())).unwrap();
        let n = loaded.rules.len();
        let first = loaded.rules[0].id().to_string();
        let last = loaded.rules[n - 1].id().to_string();
        move_rule(dir.path(), &first, None, Some(&last)).unwrap();
        let loaded = load_rules_file_from_path(&rules_path(dir.path())).unwrap();
        assert_eq!(loaded.rules[n - 1].id(), first);
    }

    #[test]
    fn move_rule_requires_before_or_after() {
        let dir = tempfile::tempdir().unwrap();
        let _ = load_rules_file(dir.path()).unwrap();
        let err = move_rule(dir.path(), "x", None, None).unwrap_err();
        assert!(err.to_string().contains("exactly one"));
    }

    #[test]
    fn move_rule_rejects_both_before_and_after() {
        let dir = tempfile::tempdir().unwrap();
        let _ = load_rules_file(dir.path()).unwrap();
        let loaded = load_rules_file_from_path(&rules_path(dir.path())).unwrap();
        let a = loaded.rules[0].id().to_string();
        let b = loaded.rules[1].id().to_string();
        let err = move_rule(dir.path(), &a, Some(&b), Some(&b)).unwrap_err();
        assert!(err.to_string().contains("only one"));
    }

    #[test]
    fn load_legacy_v1_rules_yields_unusable_error_with_recovery_hint() {
        let dir = tempfile::tempdir().unwrap();
        let path = rules_path(dir.path());
        fs::write(
            &path,
            r#"{"version":1,"rules":[{"id":"a","condition":"noise","action":"ignore"}],"context":[]}"#,
        )
        .unwrap();
        let err = load_rules_file_from_path(&path).unwrap_err();
        let s = err.to_string();
        assert!(s.contains("reset-defaults"), "{}", s);
        assert!(
            s.contains("version: 1") || s.contains("\"version\": 1"),
            "{}",
            s
        );
    }

    #[test]
    fn reset_rules_replaces_corrupt_file_with_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = rules_path(dir.path());
        fs::create_dir_all(dir.path()).unwrap();
        fs::write(&path, "{\"version\":2,\"rules\":[\n").unwrap();
        let bak = reset_rules_to_bundled_defaults(dir.path()).unwrap();
        assert!(bak.is_some());
        assert!(bak
            .as_ref()
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("rules.json.bak."));
        let loaded = load_rules_file_from_path(&path).unwrap();
        validate_rules_file(&loaded).unwrap();
        assert!(!loaded.rules.is_empty());
    }
}
