use crate::cli::args::{RulesCmd, RulesContextCmd};
use crate::cli::util::{load_cfg, zmail_home_path};
use crate::cli::CliResult;
use std::path::PathBuf;
use zmail::{
    add_context, add_rule, db, edit_rule, load_rules_file, parse_inbox_window_to_iso_cutoff,
    preview_rule_impact, print_review_text, propose_rule_from_feedback, remove_context,
    remove_rule, resolve_openai_api_key, rules_fingerprint, rules_path, InboxDispositionCounts,
    InboxOwnerContext, InboxSurfaceMode, LoadConfigOptions, OpenAiInboxClassifier,
    RefreshPreviewRow, RuleImpactPreview, RunInboxScanOptions,
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
    let Some(api_key) = resolve_openai_api_key(&LoadConfigOptions {
        home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
        env: None,
    }) else {
        return Ok(RulePreviewJson::unavailable(
            "Preview skipped because no LLM API key is configured.",
        ));
    };
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
    let owner_ctx = InboxOwnerContext::from_addresses(owner.as_deref(), &cfg.imap_aliases);
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
    let mut classifier = OpenAiInboxClassifier::new(&api_key, &rules, true, &owner_ctx);
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
    println!("  LLM time: {} ms", preview.llm_duration_ms);
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
        RulesCmd::List { text } => {
            let rules = load_rules_file(&home)?;
            if text {
                println!("Rules file: {}", rules_path(&home).display());
                println!("Rules:");
                for rule in rules.rules {
                    println!("  [{}] {} -> {}", rule.id, rule.condition, rule.action);
                }
                println!("Context:");
                for entry in rules.context {
                    println!("  [{}] {}", entry.id, entry.text);
                }
            } else {
                println!("{}", serde_json::to_string_pretty(&rules)?);
            }
        }
        RulesCmd::Show { id, text } => {
            let rules = load_rules_file(&home)?;
            if let Some(rule) = rules.rules.iter().find(|rule| rule.id == id) {
                if text {
                    println!("[{}] {} -> {}", rule.id, rule.condition, rule.action);
                } else {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "type": "rule",
                            "value": rule
                        }))?
                    );
                }
            } else if let Some(entry) = rules.context.iter().find(|entry| entry.id == id) {
                if text {
                    println!("[{}] {}", entry.id, entry.text);
                } else {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "type": "context",
                            "value": entry
                        }))?
                    );
                }
            } else {
                eprintln!("Rule or context entry not found: {id}");
                std::process::exit(1);
            }
        }
        RulesCmd::Add {
            action,
            condition,
            no_preview,
            preview_window,
            text,
        } => {
            let rule = add_rule(&home, &action, &condition)?;
            let preview = if no_preview {
                RulePreviewJson::unavailable("Preview skipped because --no-preview was set.")
            } else {
                build_rule_preview(&home, &rule.id, preview_window.as_deref())?
            };
            if text {
                println!("[{}] {} -> {}", rule.id, rule.condition, rule.action);
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
            condition,
            action,
            no_preview,
            preview_window,
            text,
        } => {
            let Some(rule) = edit_rule(&home, &id, condition.as_deref(), action.as_deref())? else {
                eprintln!("Rule not found: {id}");
                std::process::exit(1);
            };
            let preview = if no_preview {
                RulePreviewJson::unavailable("Preview skipped because --no-preview was set.")
            } else {
                build_rule_preview(&home, &rule.id, preview_window.as_deref())?
            };
            if text {
                println!("[{}] {} -> {}", rule.id, rule.condition, rule.action);
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
                println!("Removed [{}] {}", rule.id, rule.condition);
            } else {
                println!("{}", serde_json::to_string_pretty(&rule)?);
            }
        }
        RulesCmd::Context { sub } => match sub {
            RulesContextCmd::Add { text, text_mode } => {
                let entry = add_context(&home, &text)?;
                if text_mode {
                    println!("[{}] {}", entry.id, entry.text);
                } else {
                    println!("{}", serde_json::to_string_pretty(&entry)?);
                }
            }
            RulesContextCmd::Remove { id, text } => {
                let Some(entry) = remove_context(&home, &id)? else {
                    eprintln!("Context entry not found: {id}");
                    std::process::exit(1);
                };
                if text {
                    println!("Removed [{}] {}", entry.id, entry.text);
                } else {
                    println!("{}", serde_json::to_string_pretty(&entry)?);
                }
            }
        },
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
