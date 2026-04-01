use crate::cli::args::{CheckArgs, ReviewArgs, ReviewSubcommand};
use crate::cli::triage::run_triage_command;
use crate::cli::util::load_cfg;
use crate::cli::CliResult;
use std::path::PathBuf;
use zmail::{
    db, dismiss_message, resolve_openai_api_key, run_ask as run_ask_query, LoadConfigOptions,
    RunAskOptions,
};

pub(crate) fn run_ask(mut question: Vec<String>, verbose: bool) -> CliResult {
    let cfg = load_cfg();
    if question.first().is_some_and(|s| s == "--") {
        question.remove(0);
    }

    let question = question.join(" ");
    let question = question.trim();
    if question.is_empty() {
        eprintln!("Usage: zmail ask <question> [--verbose]");
        eprintln!(
            "  Answer a question about your email using an internal agent (requires ZMAIL_OPENAI_API_KEY)."
        );
        eprintln!();
        eprintln!("Example: zmail ask \"summarize my tech news this week\"");
        eprintln!(
            "  Use --verbose (or -v) to log pipeline progress (phase 1, context assembly, etc.)."
        );
        std::process::exit(1);
    }

    let Some(api_key) = resolve_openai_api_key(&LoadConfigOptions {
        home: std::env::var("ZMAIL_HOME").ok().map(PathBuf::from),
        env: None,
    }) else {
        eprintln!("zmail ask requires an LLM API key.");
        eprintln!("Set ZMAIL_OPENAI_API_KEY or run 'zmail setup' with --openai-key.");
        std::process::exit(1);
    };

    let conn = db::open_file(cfg.db_path())?;
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(run_ask_query(
        question,
        &conn,
        &cfg.data_dir,
        &cfg.imap_user,
        cfg.attachments_cache_extracted_text,
        &api_key,
        RunAskOptions {
            stream: true,
            verbose,
        },
    ))?;
    Ok(())
}

pub(crate) fn run_check(args: CheckArgs) -> CliResult {
    let cfg = load_cfg();
    run_triage_command(&cfg, &args)
}

pub(crate) fn run_review(args: ReviewArgs, sub: Option<ReviewSubcommand>) -> CliResult {
    let cfg = load_cfg();
    if let Some(ReviewSubcommand::Dismiss {
        message_id,
        no_archive,
        text,
    }) = sub
    {
        let conn = db::open_file(cfg.db_path())?;
        let archived = !no_archive;
        let ok = dismiss_message(&conn, &message_id, archived)?;
        if !ok {
            eprintln!("Message not found: {message_id}");
            std::process::exit(1);
        }
        if text {
            println!(
                "Dismissed {message_id}{}",
                if archived {
                    " and archived locally"
                } else {
                    ""
                }
            );
        } else {
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "ok": true,
                    "messageId": message_id,
                    "archived": archived,
                }))?
            );
        }
        return Ok(());
    }

    run_triage_command(&cfg, &args)
}
