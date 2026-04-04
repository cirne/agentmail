use crate::cli::args::RulesCmd;
use crate::cli::util::{load_cfg, zmail_home_path};
use crate::cli::CliResult;
use zmail::{
    add_regex_rule, db, edit_rule, load_rules_file, parse_inbox_window_to_iso_cutoff,
    preview_rule_impact, print_review_text, propose_rule_from_feedback, remove_rule,
    reset_rules_to_bundled_defaults, rules_fingerprint, rules_path, validate_rules_file,
    DeterministicInboxClassifier, InboxDispositionCounts, InboxSurfaceMode, RefreshPreviewRow,
    RuleImpactPreview, RulesError, RunInboxScanOptions,
};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RulePreviewJson {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    candidates_scanned: usize,
    llm_duration_ms: u64,
    matched_count: usize,
    matched: Vec<RefreshPreviewRow>,
}

impl RulePreviewJson {
    fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            available: false,
            reason: Some(reason.into()),
            candidates_scanned: 0,
            llm_duration_ms: 0,
            matched_count: 0,
            matched: Vec::new(),
        }
    }

    fn from_preview(preview: RuleImpactPreview) -> Self {
        Self {
            available: true,
            reason: None,
            candidates_scanned: preview.candidates_scanned,
            llm_duration_ms: preview.llm_duration_ms,
            matched_count: preview.matched.len(),
            matched: preview.matched,
        }
    }
}

fn build_rule_preview(
    home: &std::path::Path,
    rule_id: &str,
    preview_window: Option<&str>,
) -> Result<RulePreviewJson, Box<dyn std::error::Error>> {
    let cfg = load_cfg();
    let window = preview_window
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&cfg.inbox_default_window);
    let cutoff_iso = match parse_inbox_window_to_iso_cutoff(window) {
        Ok(value) => value,
        Err(err) => {
            return Ok(RulePreviewJson::unavailable(format!(
                "Preview skipped because preview window '{window}' is invalid: {err}"
            )));
        }
    };
    let conn = db::open_file(cfg.db_path())?;
    let rules = load_rules_file(home)?;
    let owner = (!cfg.imap_user.trim().is_empty()).then(|| cfg.imap_user.clone());
    let opts = RunInboxScanOptions {
        surface_mode: InboxSurfaceMode::Review,
        cutoff_iso,
        include_all: false,
        replay: true,
        reapply_llm: true,
        diagnostics: true,
        rules_fingerprint: Some(rules_fingerprint(&rules)),
        owner_address: owner,
        owner_aliases: cfg.imap_aliases.clone(),
        candidate_cap: None,
        notable_cap: None,
        batch_size: None,
    };
    let mut classifier = DeterministicInboxClassifier::new(&rules)?;
    let runtime = tokio::runtime::Runtime::new()?;
    let preview = runtime.block_on(preview_rule_impact(&conn, &opts, &mut classifier, rule_id))?;
    Ok(RulePreviewJson::from_preview(preview))
}

fn preview_counts(rows: &[RefreshPreviewRow]) -> InboxDispositionCounts {
    let mut counts = InboxDispositionCounts::default();
    for row in rows {
        match row.action.as_deref() {
            Some("notify") => counts.notify += 1,
            Some("inform") => counts.inform += 1,
            Some("ignore") => counts.ignore += 1,
            _ => {}
        }
        if row.requires_user_action {
            counts.action_required += 1;
        }
    }
    counts
}

fn print_rule_preview_text(preview: &RulePreviewJson) {
    println!();
    println!("Rule preview:");
    if !preview.available {
        if let Some(reason) = &preview.reason {
            println!("  {reason}");
        }
        return;
    }
    println!(
        "  matched {} of {} recent inbox candidates",
        preview.matched_count, preview.candidates_scanned
    );
    println!("  classify time: {} ms", preview.llm_duration_ms);
    if preview.matched.is_empty() {
        println!("  No recent messages matched this rule.");
        return;
    }
    let counts = preview_counts(&preview.matched);
    print_review_text(&preview.matched, None, &counts);
}

pub(crate) fn run_rules(sub: RulesCmd) -> CliResult {
    let home = zmail_home_path();
    match sub {
        RulesCmd::Validate => {
            let rules = load_rules_file(&home)?;
            validate_rules_file(&rules)?;
            println!("OK: {} rule(s)", rules.rules.len());
        }
        RulesCmd::ResetDefaults { yes } => {
            if !yes {
                eprintln!(
                    "This replaces {} with bundled default rules.\n\
The current file will be renamed to rules.json.bak.<uuid> in the same directory.\n\
Re-run with: zmail rules reset-defaults --yes",
                    rules_path(&home).display()
                );
                std::process::exit(1);
            }
            match reset_rules_to_bundled_defaults(&home) {
                Ok(Some(bak)) => {
                    println!("Backed up previous rules to {}", bak.display());
                    println!("Wrote bundled defaults to {}", rules_path(&home).display());
                }
                Ok(None) => {
                    println!("Wrote bundled defaults to {}", rules_path(&home).display());
                }
                Err(e) => return Err(e.into()),
            }
        }
        RulesCmd::List { text } => {
            let rules = load_rules_file(&home)?;
            if text {
                println!("Rules file: {}", rules_path(&home).display());
                println!("Rules:");
                for rule in rules.rules {
                    println!("  {}", serde_json::to_string(&rule)?);
                }
            } else {
                println!("{}", serde_json::to_string_pretty(&rules)?);
            }
        }
        RulesCmd::Show { id, text } => {
            let rules = load_rules_file(&home)?;
            if let Some(rule) = rules.rules.iter().find(|rule| rule.id() == id) {
                if text {
                    println!("{}", serde_json::to_string_pretty(rule)?);
                } else {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "type": "rule",
                            "value": rule
                        }))?
                    );
                }
            } else {
                eprintln!("Rule not found: {id}");
                std::process::exit(1);
            }
        }
        RulesCmd::Add {
            action,
            subject_pattern,
            body_pattern,
            from_pattern,
            priority,
            description,
            no_preview,
            preview_window,
            text,
        } => {
            let has_regex_input = subject_pattern
                .as_ref()
                .is_some_and(|s| !s.trim().is_empty())
                || body_pattern.as_ref().is_some_and(|s| !s.trim().is_empty())
                || from_pattern.as_ref().is_some_and(|s| !s.trim().is_empty());

            let rule = if has_regex_input {
                add_regex_rule(
                    &home,
                    &action,
                    subject_pattern,
                    body_pattern,
                    from_pattern,
                    None,
                    None,
                    description,
                    priority,
                )?
            } else {
                return Err(RulesError::InvalidRules(
                    "add at least one regex pattern: --subject-pattern, --body-pattern, --from-pattern (category/fromDomain: edit rules.json)"
                        .into(),
                )
                .into());
            };
            let preview = if no_preview {
                RulePreviewJson::unavailable("Preview skipped because --no-preview was set.")
            } else {
                build_rule_preview(&home, rule.id(), preview_window.as_deref())?
            };
            if text {
                println!("{}", serde_json::to_string_pretty(&rule)?);
                print_rule_preview_text(&preview);
            } else {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "rule": rule,
                        "preview": preview
                    }))?
                );
            }
        }
        RulesCmd::Edit {
            id,
            action,
            no_preview,
            preview_window,
            text,
        } => {
            let Some(rule) = edit_rule(&home, &id, Some(action.as_str()))? else {
                eprintln!("Rule not found: {id}");
                std::process::exit(1);
            };
            let preview = if no_preview {
                RulePreviewJson::unavailable("Preview skipped because --no-preview was set.")
            } else {
                build_rule_preview(&home, rule.id(), preview_window.as_deref())?
            };
            if text {
                println!("{}", serde_json::to_string_pretty(&rule)?);
                print_rule_preview_text(&preview);
            } else {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "rule": rule,
                        "preview": preview
                    }))?
                );
            }
        }
        RulesCmd::Remove { id, text } => {
            let Some(rule) = remove_rule(&home, &id)? else {
                eprintln!("Rule not found: {id}");
                std::process::exit(1);
            };
            if text {
                println!("Removed [{}]", rule.id());
            } else {
                println!("{}", serde_json::to_string_pretty(&rule)?);
            }
        }
        RulesCmd::Feedback { feedback, text } => {
            let proposal = propose_rule_from_feedback(&feedback);
            if text {
                println!("Proposed rule:");
                println!("  action: {}", proposal.proposed.action);
                println!("  condition: {}", proposal.proposed.condition);
                println!("Reasoning:");
                println!("  {}", proposal.reasoning);
                println!("Apply:");
                println!("  {}", proposal.apply);
            } else {
                println!("{}", serde_json::to_string_pretty(&proposal)?);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod preview_counts_tests {
    use super::preview_counts;
    use zmail::RefreshPreviewRow;

    fn row(action: Option<&str>, requires_user_action: bool) -> RefreshPreviewRow {
        RefreshPreviewRow {
            message_id: "<x@test>".into(),
            date: "2026-01-01T00:00:00Z".into(),
            from_address: "a@b.com".into(),
            from_name: None,
            subject: "s".into(),
            snippet: "b".into(),
            note: None,
            attachments: None,
            category: None,
            action: action.map(String::from),
            matched_rule_ids: vec![],
            decision_source: None,
            requires_user_action,
            action_summary: requires_user_action.then(|| "Do the thing".into()),
        }
    }

    #[test]
    fn preview_counts_action_required_independent_of_notify_inform_ignore() {
        let rows = vec![
            row(Some("notify"), true),
            row(Some("inform"), true),
            row(Some("inform"), false),
            row(Some("ignore"), true),
        ];
        let c = preview_counts(&rows);
        assert_eq!(c.notify, 1);
        assert_eq!(c.inform, 2);
        assert_eq!(c.ignore, 1);
        assert_eq!(c.action_required, 3);
    }

    #[test]
    fn preview_counts_ignores_unknown_action_but_still_counts_action_required() {
        let mut r = row(None, true);
        r.action = None;
        let c = preview_counts(std::slice::from_ref(&r));
        assert_eq!(c.notify, 0);
        assert_eq!(c.inform, 0);
        assert_eq!(c.ignore, 0);
        assert_eq!(c.action_required, 1);
    }
}
