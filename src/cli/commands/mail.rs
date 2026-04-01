use std::io::Write;

use crate::cli::args::AttachmentCmd;
use crate::cli::util::{format_attachment_size, load_cfg};
use crate::cli::CliResult;
use zmail::{
    db, format_read_message_text, list_attachments_for_message, list_thread_messages,
    parse_category_list, parse_read_full, read_attachment_text, read_message_bytes_with_thread,
    read_stored_file, resolve_message_id, resolve_search_json_format,
    search_result_to_slim_json_row, search_with_meta, send_draft_by_id, send_simple_message,
    split_address_list, who, ReadMessageJson, SearchOptions, SearchResultFormatPreference,
    SendSimpleFields, WhoOptions,
};

pub(crate) struct SendCommandArgs {
    pub(crate) draft_id: Option<String>,
    pub(crate) to: Option<String>,
    pub(crate) subject: Option<String>,
    pub(crate) body: Option<String>,
    pub(crate) cc: Option<String>,
    pub(crate) bcc: Option<String>,
    pub(crate) dry_run: bool,
    pub(crate) text: bool,
}

pub(crate) fn run_send(args: SendCommandArgs) -> CliResult {
    let cfg = load_cfg();
    if cfg.imap_user.trim().is_empty() || cfg.imap_password.is_empty() {
        eprintln!("IMAP user/password required. Run `zmail setup`.");
        std::process::exit(1);
    }

    let SendCommandArgs {
        draft_id,
        to,
        subject,
        body,
        cc,
        bcc,
        dry_run,
        text,
    } = args;

    let use_json = !text;
    if let (Some(to_addresses), Some(subject)) = (to.as_ref(), subject.as_ref()) {
        let fields = SendSimpleFields {
            to: split_address_list(to_addresses),
            cc: cc
                .as_ref()
                .map(|s| split_address_list(s))
                .filter(|v| !v.is_empty()),
            bcc: bcc
                .as_ref()
                .map(|s| split_address_list(s))
                .filter(|v| !v.is_empty()),
            subject: subject.clone(),
            text: body.unwrap_or_default(),
            in_reply_to: None,
            references: None,
        };
        print_send_result(&send_simple_message(&cfg, &fields, dry_run)?, use_json)?;
    } else if let Some(id) = draft_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        print_send_result(
            &send_draft_by_id(&cfg, &cfg.data_dir, id, dry_run)?,
            use_json,
        )?;
    } else {
        eprintln!(
            "Usage: zmail send --to <addr> --subject <s> [--body <text>] [--cc ...] [--bcc ...] [--dry-run]"
        );
        eprintln!("       zmail send <draft-id>");
        std::process::exit(1);
    }

    Ok(())
}

pub(crate) fn run_draft(sub: zmail::draft::DraftCmd) -> CliResult {
    let cfg = load_cfg();
    if cfg.imap_user.trim().is_empty() || cfg.imap_password.is_empty() {
        eprintln!("IMAP user/password required. Run `zmail setup`.");
        std::process::exit(1);
    }

    let needs_db = matches!(
        &sub,
        zmail::draft::DraftCmd::Reply { .. } | zmail::draft::DraftCmd::Forward { .. }
    );
    let conn_owned = if needs_db {
        Some(db::open_file(cfg.db_path())?)
    } else {
        None
    };
    zmail::draft::run_draft(sub, &cfg, conn_owned.as_ref())?;
    Ok(())
}

pub(crate) fn run_read(message_id: String, raw: bool, json: bool) -> CliResult {
    let cfg = load_cfg();
    let conn = db::open_file(cfg.db_path())?;
    let (bytes, _mid, thread_id) =
        read_message_bytes_with_thread(&conn, &message_id, &cfg.data_dir)??;
    if raw {
        std::io::stdout().write_all(&bytes)?;
    } else {
        let parsed = parse_read_full(&bytes);
        if json {
            let out = ReadMessageJson::from_parsed(&parsed, &thread_id);
            println!("{}", serde_json::to_string_pretty(&out)?);
        } else {
            print!("{}", format_read_message_text(&parsed));
        }
    }
    Ok(())
}

pub(crate) fn run_thread(thread_id: String, json: bool) -> CliResult {
    let cfg = load_cfg();
    let conn = db::open_file(cfg.db_path())?;
    let rows = list_thread_messages(&conn, &thread_id)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&rows)?);
    } else {
        for row in rows {
            println!(
                "{}  {}  {}",
                &row.date[..row.date.len().min(10)],
                row.from_address,
                row.subject
            );
        }
    }
    Ok(())
}

pub(crate) fn run_attachment(sub: AttachmentCmd) -> CliResult {
    let cfg = load_cfg();
    let conn = db::open_file(cfg.db_path())?;
    let cache = cfg.attachments_cache_extracted_text;

    match sub {
        AttachmentCmd::List { message_id, text } => {
            let exists = resolve_message_id(&conn, &message_id)?.is_some();
            if !exists {
                println!("{}", if text { "No attachments found." } else { "[]" });
                return Ok(());
            }

            let rows = list_attachments_for_message(&conn, &message_id)?;
            if text {
                print_attachment_table(&message_id, &rows);
            } else {
                let json_rows: Vec<serde_json::Value> = rows
                    .iter()
                    .enumerate()
                    .map(|(index, attachment)| {
                        serde_json::json!({
                            "index": index + 1,
                            "filename": &attachment.filename,
                            "mimeType": &attachment.mime_type,
                            "size": attachment.size,
                            "extracted": attachment.extracted,
                        })
                    })
                    .collect();
                println!("{}", serde_json::to_string_pretty(&json_rows)?);
            }
        }
        AttachmentCmd::Read {
            message_id,
            index_or_name,
            raw,
            no_cache,
        } => {
            let rows = list_attachments_for_message(&conn, &message_id)?;
            if rows.is_empty() {
                eprintln!("No attachments found for message.");
                std::process::exit(1);
            }
            let attachment = resolve_attachment(&rows, &index_or_name);
            if raw {
                let bytes = read_stored_file(&attachment.stored_path, &cfg.data_dir)?;
                std::io::stdout().write_all(&bytes)?;
            } else {
                let text =
                    read_attachment_text(&conn, &cfg.data_dir, attachment.id, cache, no_cache)
                        .map_err(std::io::Error::other)?;
                println!("{text}");
            }
        }
    }

    Ok(())
}

pub(crate) fn run_who(
    query: Option<String>,
    limit: usize,
    include_noreply: bool,
    text: bool,
) -> CliResult {
    let cfg = load_cfg();
    let conn = db::open_file(cfg.db_path())?;
    let result = who(
        &conn,
        &WhoOptions {
            query: query.unwrap_or_default(),
            limit,
            include_noreply,
        },
    )?;
    if text {
        for person in &result.people {
            println!(
                "{}  sent={} recv={}  rank={:.2}",
                person.primary_address,
                person.sent_count,
                person.received_count,
                person.contact_rank
            );
        }
    } else {
        println!("{}", serde_json::to_string_pretty(&result)?);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_search(
    query: String,
    limit: Option<usize>,
    from: Option<String>,
    after: Option<String>,
    before: Option<String>,
    include_all: bool,
    category: Option<String>,
    text: bool,
    result_format: Option<String>,
    timings: bool,
) -> CliResult {
    let cfg = load_cfg();
    let conn = db::open_file(cfg.db_path())?;
    let owner = (!cfg.imap_user.trim().is_empty()).then(|| cfg.imap_user.clone());
    let result = search_with_meta(
        &conn,
        &SearchOptions {
            query: Some(query),
            limit,
            from_address: from,
            after_date: after,
            before_date: before,
            include_all,
            categories: category
                .as_deref()
                .map(parse_category_list)
                .unwrap_or_default(),
            owner_address: owner,
            ..Default::default()
        },
    )?;

    if text {
        let count = result.results.len();
        let total = result.total_matched.unwrap_or(count as i64);
        println!(
            "Found {count} result{}{}",
            if count == 1 { "" } else { "s" },
            if total > count as i64 {
                format!(" (of {total} total)")
            } else {
                String::new()
            }
        );
        for row in &result.results {
            println!(
                "{}  {}  {}",
                &row.date[..row.date.len().min(10)],
                row.from_address,
                row.subject
            );
        }
    } else {
        let preference = match result_format.as_deref() {
            Some("full") => SearchResultFormatPreference::Full,
            Some("slim") => SearchResultFormatPreference::Slim,
            _ => SearchResultFormatPreference::Auto,
        };
        let format = resolve_search_json_format(result.results.len(), preference, true);
        let rows: Vec<serde_json::Value> = match format {
            zmail::SearchJsonFormat::Slim => result
                .results
                .iter()
                .map(search_result_to_slim_json_row)
                .collect(),
            zmail::SearchJsonFormat::Full => result
                .results
                .iter()
                .map(|row| serde_json::to_value(row).unwrap())
                .collect(),
        };
        let mut out = serde_json::json!({
            "results": rows,
            "totalMatched": result.total_matched.unwrap_or(rows.len() as i64),
        });
        if timings {
            out["timings"] = serde_json::to_value(&result.timings)?;
        }
        println!("{}", serde_json::to_string_pretty(&out)?);
    }
    Ok(())
}

fn print_send_result(result: &zmail::SendResult, use_json: bool) -> CliResult {
    if use_json {
        println!("{}", serde_json::to_string_pretty(result)?);
    } else {
        print!("ok={} messageId={}", result.ok, result.message_id);
        if result.dry_run == Some(true) {
            print!(" dryRun=true");
        }
        println!();
        if let Some(response) = &result.smtp_response {
            println!("{response}");
        }
    }
    Ok(())
}

fn print_attachment_table(message_id: &str, rows: &[zmail::AttachmentListRow]) {
    if rows.is_empty() {
        println!("No attachments found.");
        return;
    }

    println!("Attachments for {message_id}:\n");
    println!(
        "  {:>4}  {:<40}  {:<38}  {:>9}  EXTRACTED",
        "#", "FILENAME", "MIME TYPE", "SIZE"
    );
    println!("  {}", "-".repeat(100));
    for row in rows {
        let size = format_attachment_size(row.size);
        let filename = if row.filename.len() > 40 {
            format!("{}...", &row.filename[..37])
        } else {
            format!("{:<40}", row.filename)
        };
        let mime = if row.mime_type.len() > 38 {
            format!("{}...", &row.mime_type[..35])
        } else {
            format!("{:<38}", row.mime_type)
        };
        println!(
            "  {:>4}  {}  {}  {:>9}  {}",
            row.index,
            filename,
            mime,
            size,
            if row.extracted { "yes" } else { "no" }
        );
    }
}

fn resolve_attachment<'a>(
    rows: &'a [zmail::AttachmentListRow],
    index_or_name: &str,
) -> &'a zmail::AttachmentListRow {
    if let Ok(index) = index_or_name.parse::<usize>() {
        if index >= 1 && index <= rows.len() {
            return &rows[index - 1];
        }
        eprintln!(
            "No attachment \"{}\" in this message. Use index 1-{}",
            index_or_name,
            rows.len()
        );
        std::process::exit(1);
    }

    if let Some(attachment) = rows.iter().find(|row| row.filename == index_or_name) {
        return attachment;
    }

    eprintln!(
        "No attachment \"{}\" in this message. Use index 1-{} or exact filename.",
        index_or_name,
        rows.len()
    );
    std::process::exit(1);
}
