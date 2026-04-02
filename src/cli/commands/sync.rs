use crate::cli::triage::{
    print_sync_foreground_metrics, run_sync_foreground_backward, run_sync_foreground_refresh,
};
use crate::cli::util::{load_cfg, zmail_home_path};
use crate::cli::CliResult;
use zmail::{
    build_refresh_json_value, collect_stats, db, get_imap_server_status, handle_request_line,
    load_refresh_new_mail, print_refresh_text, print_status_text, rebuild_from_maildir,
    spawn_sync_background_detached,
};

pub(crate) fn run_update(
    duration: Option<String>,
    since: Option<String>,
    foreground: bool,
    force: bool,
    text: bool,
) -> CliResult {
    let cfg = load_cfg();
    let since_spec = since
        .as_deref()
        .or(duration.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(spec) = since_spec {
        if foreground {
            let result = run_sync_foreground_backward(&cfg, Some(spec))?;
            print_sync_foreground_metrics(&result);
        } else {
            spawn_sync_background_detached(&zmail_home_path(), &cfg, Some(spec))?;
        }
        return Ok(());
    }

    let conn = db::open_file(cfg.db_path())?;
    let result = run_sync_foreground_refresh(&cfg, force, true)?;
    let ids = result.new_message_ids.clone().unwrap_or_default();
    let new_mail = load_refresh_new_mail(
        &conn,
        &ids,
        true,
        (!cfg.imap_user.trim().is_empty()).then_some(cfg.imap_user.as_str()),
    )?;
    if text {
        print_refresh_text(&result, &new_mail);
    } else {
        println!(
            "{}",
            serde_json::to_string_pretty(&build_refresh_json_value(&result, &new_mail))?
        );
    }
    Ok(())
}

pub(crate) fn run_status(json: bool, imap: bool) -> CliResult {
    let cfg = load_cfg();
    let conn = db::open_file(cfg.db_path())?;
    if json {
        let status = zmail::get_status(&conn)?;
        let latest_mail_ago = zmail::format_time_ago(
            status
                .date_range
                .as_ref()
                .map(|(_, latest)| latest.as_str()),
        );
        let last_sync_ago = if status.sync.is_running {
            None
        } else {
            zmail::format_time_ago(status.sync.last_sync_at.as_deref())
        };
        let mut out = serde_json::json!({
            "sync": {
                "isRunning": status.sync.is_running,
                "lastSyncAt": status.sync.last_sync_at,
                "totalMessages": status.sync.total_messages,
                "earliestSyncedDate": status.sync.earliest_synced_date,
                "latestSyncedDate": status.sync.latest_synced_date,
                "targetStartDate": status.sync.target_start_date,
                "syncStartEarliestDate": status.sync.sync_start_earliest_date,
            },
            "search": { "ftsReady": status.fts_ready },
            "dateRange": status.date_range.as_ref().map(|(earliest, latest)| serde_json::json!({
                "earliest": earliest,
                "latest": latest,
            })),
            "freshness": {
                "latestMailAgo": latest_mail_ago.as_ref().map(|time| serde_json::json!({
                    "human": time.human,
                    "duration": time.duration,
                })),
                "lastSyncAgo": last_sync_ago.as_ref().map(|time| serde_json::json!({
                    "human": time.human,
                    "duration": time.duration,
                })),
            },
        });
        if imap {
            if let Some(imap_status) = get_imap_server_status(&conn, &cfg)? {
                out["imap"] = serde_json::json!({
                    "server": {
                        "messages": imap_status.server.messages,
                        "uidNext": imap_status.server.uid_next,
                        "uidValidity": imap_status.server.uid_validity,
                    },
                    "local": {
                        "messages": imap_status.local.messages,
                        "lastUid": imap_status.local.uid_next,
                        "uidValidity": imap_status.local.uid_validity,
                    },
                    "missing": imap_status.missing,
                    "missingUidRange": imap_status.missing_uid_range.as_ref().map(|(start, end)| serde_json::json!({
                        "start": start,
                        "end": end,
                    })),
                    "uidValidityMismatch": imap_status.uid_validity_mismatch,
                    "coverage": imap_status.coverage.as_ref().map(|coverage| serde_json::json!({
                        "daysAgo": coverage.days_ago,
                        "yearsAgo": coverage.years_ago,
                        "earliestDate": coverage.earliest_date,
                    })),
                });
            }
        }
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }

    print_status_text(&conn)?;
    if imap {
        if let Some(imap_status) = get_imap_server_status(&conn, &cfg)? {
            println!();
            println!("Server comparison:");
            println!(
                "  Server:   {} messages, UIDNEXT={}, UIDVALIDITY={}",
                imap_status.server.messages,
                imap_status
                    .server
                    .uid_next
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown".into()),
                imap_status
                    .server
                    .uid_validity
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "unknown".into())
            );
            println!(
                "  Local:    {} messages, last_uid={}, UIDVALIDITY={}",
                imap_status.local.messages,
                imap_status
                    .local
                    .uid_next
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "none".into()),
                imap_status
                    .local
                    .uid_validity
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "none".into())
            );
            if let (Some(missing), Some((start, end))) =
                (imap_status.missing, imap_status.missing_uid_range)
            {
                if missing > 0 {
                    println!("  Missing:  {missing} new message(s) (UIDs {start}..{end})");
                }
            } else if imap_status.missing == Some(0) {
                println!("  Status:   Up to date (no new messages)");
            }
            if imap_status.uid_validity_mismatch {
                println!("  Warning:  UIDVALIDITY mismatch - mailbox may have been reset");
            }
            if let Some(coverage) = imap_status.coverage {
                println!(
                    "  Coverage: Goes back {} days ({} years) to {}",
                    coverage.days_ago, coverage.years_ago, coverage.earliest_date
                );
            }
        }
    } else {
        println!();
        println!("Hint: Add --imap flag to show IMAP server status (may take 10+ seconds longer)");
    }
    Ok(())
}

pub(crate) fn run_stats(json: bool) -> CliResult {
    let cfg = load_cfg();
    let conn = db::open_file(cfg.db_path())?;
    let stats = collect_stats(&conn)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&stats)?);
    } else {
        println!(
            "messages={} threads={} attachments={} people={}",
            stats.message_count, stats.thread_count, stats.attachment_count, stats.people_count
        );
    }
    Ok(())
}

pub(crate) fn run_rebuild_index() -> CliResult {
    let cfg = load_cfg();
    let mut conn = db::open_file(cfg.db_path())?;
    let count = rebuild_from_maildir(&mut conn, cfg.maildir_path())?;
    println!(
        "Reindexed {count} messages from {}",
        cfg.maildir_path().display()
    );
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    match rt.block_on(zmail::run_post_rebuild_inbox_bootstrap(
        &conn,
        &cfg,
        cfg.inbox_bootstrap_archive_older_than.as_str(),
        false,
    )) {
        Ok(s) => {
            eprintln!(
                "Inbox bootstrap: bulk-archived {} older-than-window messages; classified {} candidates (LLM skipped: {})",
                s.bulk_archived_older_than_cutoff,
                s.inbox_candidates_classified,
                s.llm_skipped_no_api_key
            );
        }
        Err(e) => eprintln!("Inbox bootstrap failed: {e}"),
    }
    Ok(())
}

pub(crate) fn run_mcp() -> CliResult {
    let cfg = load_cfg();
    let conn = db::open_file(cfg.db_path())?;
    let cache = cfg.attachments_cache_extracted_text;
    let stdin = std::io::stdin();
    for line in stdin.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let response = handle_request_line(&conn, &cfg.data_dir, cache, &line);
        println!("{response}");
    }
    Ok(())
}
