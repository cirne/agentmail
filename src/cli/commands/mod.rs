mod archive;
mod assist;
mod mail;
mod rules;
mod setup;
mod sync;

use crate::cli::args::Commands;
use crate::cli::CliResult;

pub(crate) fn handle_command(command: Commands) -> CliResult {
    match command {
        Commands::Setup {
            email,
            password,
            openai_key,
            no_validate,
        } => setup::run_setup(email, password, openai_key, no_validate),
        Commands::Wizard {
            no_validate,
            clean,
            yes,
        } => setup::run_wizard_command(no_validate, clean, yes),
        Commands::Update {
            duration,
            since,
            foreground,
            force,
            text,
        } => sync::run_update(duration, since, foreground, force, text),
        Commands::Status { json, imap } => sync::run_status(json, imap),
        Commands::Stats { json } => sync::run_stats(json),
        Commands::RebuildIndex => sync::run_rebuild_index(),
        Commands::Mcp => sync::run_mcp(),
        Commands::Search {
            query,
            limit,
            from,
            after,
            before,
            include_all,
            category,
            text,
            json: _json,
            result_format,
            timings,
        } => mail::run_search(
            query,
            limit,
            from,
            after,
            before,
            include_all,
            category,
            text,
            result_format,
            timings,
        ),
        Commands::Who {
            query,
            limit,
            include_noreply,
            text,
        } => mail::run_who(query, limit, include_noreply, text),
        Commands::Read {
            message_id,
            raw,
            json,
            text: _text,
        } => mail::run_read(message_id, raw, json),
        Commands::Thread {
            thread_id,
            json,
            text: _text,
        } => mail::run_thread(thread_id, json),
        Commands::Attachment { sub } => mail::run_attachment(sub),
        Commands::Send {
            draft_id,
            to,
            subject,
            body,
            cc,
            bcc,
            dry_run,
            text,
        } => mail::run_send(mail::SendCommandArgs {
            draft_id,
            to,
            subject,
            body,
            cc,
            bcc,
            dry_run,
            text,
        }),
        Commands::Draft { sub } => mail::run_draft(sub),
        Commands::Rules { sub } => rules::run_rules(sub),
        Commands::Ask { question, verbose } => assist::run_ask(question, verbose),
        Commands::Check(args) => assist::run_check(args),
        Commands::Review(args) => assist::run_review(args),
        Commands::Archive { message_ids, undo } => archive::run_archive(message_ids, undo),
    }
}
