use crate::cli::args::{RulesCmd, RulesContextCmd};
use crate::cli::util::zmail_home_path;
use crate::cli::CliResult;
use zmail::{
    add_context, add_rule, edit_rule, load_rules_file, propose_rule_from_feedback, remove_context,
    remove_rule, rules_path,
};

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
            text,
        } => {
            let rule = add_rule(&home, &action, &condition)?;
            if text {
                println!("[{}] {} -> {}", rule.id, rule.condition, rule.action);
            } else {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({ "rule": rule }))?
                );
            }
        }
        RulesCmd::Edit {
            id,
            condition,
            action,
            text,
        } => {
            let Some(rule) = edit_rule(&home, &id, condition.as_deref(), action.as_deref())? else {
                eprintln!("Rule not found: {id}");
                std::process::exit(1);
            };
            if text {
                println!("[{}] {} -> {}", rule.id, rule.condition, rule.action);
            } else {
                println!("{}", serde_json::to_string_pretty(&rule)?);
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
