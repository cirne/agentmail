//! IMAP sync engine (`run_sync`) — mirrors `src/sync/index.ts` `runSync`.

use std::collections::HashSet;
use std::path::Path;
use std::time::Instant;

use rusqlite::{params, Connection, OptionalExtension};

use crate::config::Config;
use crate::db::message_persist::{persist_attachments_from_parsed, persist_message};

use super::error::RunSyncError;
use super::fetch_timeout::timeout_ms_for_fetch_all_attempt;
use super::imap_date::ymd_to_imap_since;
use super::parse_raw_message;
use super::parse_since_to_date;
use super::process_lock::{acquire_lock, is_sync_lock_held, release_lock, SyncLockRow};
use super::retry::{retry_with_backoff, RetryPolicy};
use super::sync_log::SyncFileLogger;
use super::transport::{FetchedMessage, ImapStatusData, SyncImapTransport};
use super::windows::{forward_uid_range, oldest_message_date_for_folder};
use super::write_maildir_message;

const BATCH_SIZE_FORWARD: usize = 50;
const BATCH_SIZE_BACKWARD: usize = 300;
const NEW_MESSAGE_IDS_CAP: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncDirection {
    Forward,
    Backward,
}

#[derive(Debug, Clone)]
pub struct SyncOptions {
    pub direction: SyncDirection,
    /// Resolved calendar start `YYYY-MM-DD` (from `--since` or `sync.defaultSince`).
    pub since_ymd: String,
    pub force: bool,
    pub progress_stderr: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SyncResult {
    pub synced: u32,
    pub messages_fetched: u32,
    pub bytes_downloaded: u64,
    pub duration_ms: u64,
    pub bandwidth_bytes_per_sec: f64,
    pub messages_per_minute: f64,
    pub log_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub early_exit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_message_ids: Option<Vec<String>>,
}

impl SyncResult {
    fn empty(duration_ms: u64, log_path: String) -> Self {
        Self {
            synced: 0,
            messages_fetched: 0,
            bytes_downloaded: 0,
            duration_ms,
            bandwidth_bytes_per_sec: 0.0,
            messages_per_minute: 0.0,
            log_path,
            early_exit: None,
            new_message_ids: None,
        }
    }
}

/// Resolve mailbox name (Gmail All Mail vs INBOX).
pub fn resolve_sync_mailbox(cfg: &Config) -> String {
    if !cfg.sync_mailbox.trim().is_empty() {
        return cfg.sync_mailbox.clone();
    }
    if cfg.imap_host.to_lowercase().contains("gmail") {
        "[Gmail]/All Mail".into()
    } else {
        "INBOX".into()
    }
}

/// True when STATUS says there is nothing new after `last_uid` (forward refresh only).
pub fn should_early_exit_forward(
    force: bool,
    state: Option<(u32, u32)>,
    status: &ImapStatusData,
) -> bool {
    if force {
        return false;
    }
    let Some((st_v, st_last)) = state else {
        return false;
    };
    let Some(un) = status.uid_next else {
        return false;
    };
    let Some(sv) = status.uid_validity else {
        return false;
    };
    if sv != st_v {
        return false;
    }
    un.saturating_sub(1) <= st_last
}

fn maildir_basename(uid: u32, message_id: &str) -> String {
    let safe: String = message_id
        .chars()
        .map(|c| match c {
            '<' | '>' | '"' | '\\' | '/' => '_',
            c => c,
        })
        .take(80)
        .collect();
    let safe = if safe.is_empty() { "msg".into() } else { safe };
    format!("{uid}_{safe}")
}

fn load_sync_state(conn: &Connection, folder: &str) -> rusqlite::Result<Option<(u32, u32)>> {
    conn.query_row(
        "SELECT uidvalidity, last_uid FROM sync_state WHERE folder = ?1",
        [folder],
        |row| Ok((row.get::<_, i64>(0)? as u32, row.get::<_, i64>(1)? as u32)),
    )
    .optional()
}

fn max_uid_messages(conn: &Connection, folder: &str) -> rusqlite::Result<i64> {
    let v: Option<i64> = conn.query_row(
        "SELECT MAX(uid) FROM messages WHERE folder = ?1",
        [folder],
        |row| row.get(0),
    )?;
    Ok(v.unwrap_or(0))
}

fn existing_uids_set(conn: &Connection, folder: &str) -> rusqlite::Result<HashSet<u32>> {
    let mut stmt = conn.prepare("SELECT uid FROM messages WHERE folder = ?1")?;
    let rows = stmt.query_map([folder], |row| row.get::<_, i64>(0))?;
    rows.map(|r| r.map(|uid| uid as u32)).collect()
}

fn label_excluded(labels: &[String], exclude_lower: &HashSet<String>) -> bool {
    labels
        .iter()
        .any(|l| exclude_lower.contains(&l.to_lowercase()))
}

fn uid_fetch_with_retries(
    transport: &mut dyn SyncImapTransport,
    uid_csv: &str,
    logger: &SyncFileLogger,
    batch_len: usize,
) -> Result<Vec<FetchedMessage>, RunSyncError> {
    let policy = RetryPolicy::uid_fetch_batch();
    let fetched = retry_with_backoff(
        &policy,
        || transport.uid_fetch_rfc822_batch(uid_csv),
        |attempt, err, _sleep| {
            let recommended_timeout = timeout_ms_for_fetch_all_attempt(batch_len, attempt as u32);
            let es = err.to_string();
            logger.warn(
                "UID FETCH batch failed",
                Some(
                    format!(
                        "{{\"attempt\":{attempt},\"recommendedTimeoutMs\":{recommended_timeout},\"err\":\"{es}\"}}"
                    )
                    .as_str(),
                ),
            );
        },
    );
    match fetched {
        Ok(v) => Ok(v),
        Err(e) => {
            let s = e.to_string();
            if s.contains("timed out") || s.contains("timeout") {
                Err(RunSyncError::FetchTimeout)
            } else {
                Err(e)
            }
        }
    }
}

fn progress_line(options: &SyncOptions, msg: &str) {
    if options.progress_stderr {
        eprintln!("zmail: {msg}");
    }
}

/// Mirror Node `logSyncMetrics`: structured "Sync complete" + one-line "Sync metrics" for agents tailing `sync.log`.
fn log_sync_metrics(logger: &SyncFileLogger, r: &SyncResult) {
    let complete = serde_json::json!({
        "synced": r.synced,
        "messagesFetched": r.messages_fetched,
        "bytesDownloaded": r.bytes_downloaded,
        "durationMs": r.duration_ms,
        "bandwidthBytesPerSec": r.bandwidth_bytes_per_sec.round() as i64,
        "messagesPerMinute": r.messages_per_minute.round() as i64,
    })
    .to_string();
    logger.info("Sync complete", Some(&complete));

    let duration_sec = (r.duration_ms as f64) / 1000.0;
    let down = format_bytes_u64(r.bytes_downloaded);
    let bandwidth = format_bytes_per_sec(r.bandwidth_bytes_per_sec);
    let throughput = format!("{} msg/min", r.messages_per_minute.round() as i64);
    let summary = format!(
        "{} new, {} fetched | {} down | {} | {} | {duration_sec:.2}s",
        r.synced, r.messages_fetched, down, bandwidth, throughput
    );
    let metrics_line = serde_json::json!({ "summary": summary }).to_string();
    logger.info("Sync metrics", Some(&metrics_line));
    let finished = serde_json::json!({ "outcome": "ok", "success": true }).to_string();
    logger.info("Sync run finished", Some(&finished));
}

fn format_bytes_u64(n: u64) -> String {
    format_bytes_f64(n as f64)
}

fn format_bytes_f64(n: f64) -> String {
    if n >= 1024.0 * 1024.0 {
        format!("{:.2} MB", n / (1024.0 * 1024.0))
    } else if n >= 1024.0 {
        format!("{:.2} KB", n / 1024.0)
    } else {
        format!("{:.0} B", n)
    }
}

fn format_bytes_per_sec(n: f64) -> String {
    format!("{}/s", format_bytes_f64(n))
}

fn ensure_maildir(maildir: &Path) -> Result<(), RunSyncError> {
    for sub in ["cur", "new", "tmp", "attachments"] {
        std::fs::create_dir_all(maildir.join(sub))?;
    }
    Ok(())
}

fn ymd_minus_one_day(ymd: &str) -> Option<String> {
    let d = chrono::NaiveDate::parse_from_str(ymd, "%Y-%m-%d").ok()?;
    d.checked_sub_days(chrono::Days::new(1))
        .map(|x| x.format("%Y-%m-%d").to_string())
}

struct RunSyncLockedPrelude {
    exclude_lower: HashSet<String>,
    log_path_str: String,
}

enum RunSyncPreAcquire {
    Done(SyncResult),
    AcquireLock(RunSyncLockedPrelude),
}

#[allow(clippy::too_many_arguments)]
fn run_sync_pre_acquire(
    conn: &mut Connection,
    logger: &SyncFileLogger,
    maildir_path: &Path,
    exclude_labels: &[String],
    options: &SyncOptions,
    start: Instant,
    pid_u32: u32,
    _pid: i64,
) -> Result<RunSyncPreAcquire, RunSyncError> {
    let log_path_str = logger.log_path().to_string_lossy().to_string();
    logger.write_separator(pid_u32);
    let exclude_lower: HashSet<String> = exclude_labels.iter().map(|s| s.to_lowercase()).collect();

    let lock_row: Option<SyncLockRow> = conn
        .query_row(
            "SELECT is_running, owner_pid, sync_lock_started_at FROM sync_summary WHERE id = 1",
            [],
            |row| {
                Ok(SyncLockRow {
                    is_running: row.get(0)?,
                    owner_pid: row.get(1)?,
                    sync_lock_started_at: row.get(2)?,
                })
            },
        )
        .optional()?;

    if is_sync_lock_held(lock_row.as_ref()) {
        logger.info("Sync already running, exiting", None);
        let duration_ms = start.elapsed().as_millis() as u64;
        return Ok(RunSyncPreAcquire::Done(SyncResult::empty(
            duration_ms,
            log_path_str,
        )));
    }

    ensure_maildir(maildir_path)?;

    let from_ymd = options.since_ymd.as_str();
    conn.execute(
        "UPDATE sync_summary SET target_start_date = ?1,
         sync_start_earliest_date = (SELECT earliest_synced_date FROM sync_summary WHERE id = 1)
         WHERE id = 1",
        [from_ymd],
    )?;

    Ok(RunSyncPreAcquire::AcquireLock(RunSyncLockedPrelude {
        exclude_lower,
        log_path_str,
    }))
}

#[allow(clippy::too_many_arguments)]
fn run_sync_imap_phase(
    transport: &mut dyn SyncImapTransport,
    conn: &mut Connection,
    logger: &SyncFileLogger,
    mailbox: &str,
    maildir_path: &Path,
    exclude_lower: &HashSet<String>,
    options: &SyncOptions,
    start: Instant,
    log_path_str: String,
    pid: i64,
) -> Result<SyncResult, RunSyncError> {
    let from_ymd = options.since_ymd.as_str();
    let state = load_sync_state(conn, mailbox)?;

    let status = match transport.mailbox_status(mailbox) {
        Ok(s) => s,
        Err(e) => {
            logger.warn("STATUS failed, continuing", Some(&e.to_string()));
            ImapStatusData::default()
        }
    };

    if options.direction == SyncDirection::Forward
        && should_early_exit_forward(options.force, state, &status)
    {
        conn.execute(
            "UPDATE sync_summary SET last_sync_at = datetime('now') WHERE id = 1",
            [],
        )?;
        release_lock(conn, Some(pid))?;
        let duration_ms = start.elapsed().as_millis() as u64;
        let mut r = SyncResult::empty(duration_ms, log_path_str.clone());
        r.early_exit = Some(true);
        logger.info("Early exit: no new messages", None);
        log_sync_metrics(logger, &r);
        progress_line(
            options,
            "No new mail (server reports nothing after last sync).",
        );
        return Ok(r);
    }

    progress_line(options, "Opening mailbox…");
    let uidvalidity = transport.examine_mailbox(mailbox)?;
    progress_line(options, "Mailbox open; searching for messages to sync…");
    let state_u32 = state;

    let mut uids: Vec<u32> = Vec::new();
    let mut is_expanding_range_backward = false;

    // Forward with valid `sync_state`: UID range only (empty UIDs ⇒ no date fallback).
    let mut forward_checkpoint_only = false;
    if options.direction == SyncDirection::Forward {
        if let Some((st_v, st_last)) = state_u32 {
            if st_last > 0 && st_v == uidvalidity {
                let q = format!("UID {}", forward_uid_range(st_last as i64));
                uids = transport.uid_search_keys(&q)?;
                logger.info(
                    "Forward sync (checkpoint)",
                    Some(format!("{{\"uids\":{}}}", uids.len()).as_str()),
                );
                forward_checkpoint_only = true;
            }
        }
    }

    if !forward_checkpoint_only {
        if uids.is_empty() && options.direction == SyncDirection::Forward {
            let local_max = max_uid_messages(conn, mailbox)?;
            if local_max > 0 && uidvalidity > 0 {
                let checkpoint_ok = state_u32.map(|(v, _)| v == uidvalidity).unwrap_or(true);
                if checkpoint_ok {
                    let q = format!("UID {}", forward_uid_range(local_max));
                    uids = transport.uid_search_keys(&q)?;
                    logger.info(
                        "Forward sync (MAX uid recovery)",
                        Some(
                            format!("{{\"localMax\":{local_max},\"uids\":{}}}", uids.len())
                                .as_str(),
                        ),
                    );
                }
            }
        }

        if uids.is_empty() {
            let imap_since = ymd_to_imap_since(from_ymd).map_err(RunSyncError::Config)?;
            let since_date = chrono::NaiveDate::parse_from_str(from_ymd, "%Y-%m-%d")
                .map_err(|e| RunSyncError::Config(e.to_string()))?;

            let mut effective_since_ymd = from_ymd.to_string();

            if options.direction == SyncDirection::Backward {
                if let Some(oldest_s) = oldest_message_date_for_folder(conn, mailbox)? {
                    let oldest_day: String = oldest_s.chars().take(10).collect();
                    if oldest_day.len() == 10 && oldest_day.as_str() > from_ymd {
                        is_expanding_range_backward = true;
                        effective_since_ymd = from_ymd.to_string();
                    }
                }
            }

            let imap_eff = ymd_to_imap_since(&effective_since_ymd).map_err(RunSyncError::Config)?;

            uids = transport.uid_search_keys(&format!("SINCE {imap_eff}"))?;
            logger.info(
                "Date-based UID search",
                Some(
                    format!(
                        "{{\"count\":{},\"since\":\"{}\",\"backward\":{}}}",
                        uids.len(),
                        effective_since_ymd,
                        options.direction == SyncDirection::Backward
                    )
                    .as_str(),
                ),
            );

            if options.direction == SyncDirection::Backward {
                if let Some((st_v, st_last)) = state_u32 {
                    if st_last > 0 && st_v == uidvalidity {
                        if is_expanding_range_backward {
                            let existing = existing_uids_set(conn, mailbox)?;
                            let before = uids.len();
                            uids.retain(|u| !existing.contains(u));
                            logger.info(
                                "Filtered UIDs (range expand)",
                                Some(
                                    format!("{{\"before\":{before},\"after\":{}}}", uids.len())
                                        .as_str(),
                                ),
                            );
                        } else {
                            let all_le = !uids.is_empty() && uids.iter().all(|&u| u <= st_last);
                            if all_le {
                                if let Some(oldest_s) =
                                    oldest_message_date_for_folder(conn, mailbox)?
                                {
                                    let oldest_day: String = oldest_s.chars().take(10).collect();
                                    if let Some(prev) = ymd_minus_one_day(&oldest_day) {
                                        if chrono::NaiveDate::parse_from_str(&prev, "%Y-%m-%d")
                                            .map(|d| d >= since_date)
                                            .unwrap_or(false)
                                        {
                                            let before_imap = ymd_to_imap_since(&prev)
                                                .map_err(RunSyncError::Config)?;
                                            let q =
                                                format!("SINCE {imap_since} BEFORE {before_imap}");
                                            uids = transport.uid_search_keys(&q)?;
                                        } else {
                                            uids.clear();
                                        }
                                    }
                                }
                            } else {
                                let before = uids.len();
                                uids.retain(|&u| u > st_last);
                                if before != uids.len() {
                                    logger.info(
                                        "Filtered UIDs (last_uid)",
                                        Some(
                                            format!(
                                                "{{\"before\":{before},\"after\":{}}}",
                                                uids.len()
                                            )
                                            .as_str(),
                                        ),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    uids.sort_unstable_by(|a, b| b.cmp(a));

    if uids.is_empty() {
        progress_line(options, "No messages to download for this run.");
        conn.execute(
            "UPDATE sync_summary SET last_sync_at = datetime('now') WHERE id = 1",
            [],
        )?;
        release_lock(conn, Some(pid))?;
        let duration_ms = start.elapsed().as_millis() as u64;
        let r = SyncResult::empty(duration_ms, log_path_str.clone());
        log_sync_metrics(logger, &r);
        return Ok(r);
    }

    progress_line(options, &format!("Downloading {} message(s)…", uids.len()));

    let batch_size = match options.direction {
        SyncDirection::Forward => BATCH_SIZE_FORWARD,
        SyncDirection::Backward => BATCH_SIZE_BACKWARD,
    };

    let mut synced = 0u32;
    let mut messages_fetched = 0u32;
    let mut bytes_downloaded = 0u64;
    let mut earliest_date: Option<String> = None;
    let mut latest_date: Option<String> = None;
    let mut new_message_ids: Vec<String> = Vec::new();

    let mut checkpoint_uid = state_u32
        .filter(|(v, _)| *v == uidvalidity)
        .map(|(_, u)| u)
        .unwrap_or(0);

    let total_batches = uids.len().div_ceil(batch_size);
    for (bi, chunk) in uids.chunks(batch_size).enumerate() {
        if total_batches > 1 {
            progress_line(
                options,
                &format!(
                    "Fetching batch {}/{} ({} message(s))…",
                    bi + 1,
                    total_batches,
                    chunk.len()
                ),
            );
        }
        let uid_csv: String = chunk
            .iter()
            .map(|u| u.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let fetched = uid_fetch_with_retries(transport, &uid_csv, logger, chunk.len())?;

        for msg in fetched {
            messages_fetched += 1;
            bytes_downloaded += msg.raw.len() as u64;

            if label_excluded(&msg.labels, exclude_lower) {
                continue;
            }

            let parsed = parse_raw_message(&msg.raw);

            let dup: Option<i32> = conn
                .query_row(
                    "SELECT 1 FROM messages WHERE message_id = ?1",
                    [&parsed.message_id],
                    |row| row.get(0),
                )
                .optional()?;
            if dup.is_some() {
                continue;
            }

            let basename = maildir_basename(msg.uid, &parsed.message_id);
            let cur = maildir_path.join("cur");
            let written = write_maildir_message(&cur, &basename, &msg.raw, &msg.labels)?;
            let labels_json = serde_json::to_string(&msg.labels).unwrap_or_else(|_| "[]".into());

            let inserted = persist_message(
                conn,
                &parsed,
                mailbox,
                msg.uid as i64,
                &labels_json,
                &written.relative_raw_path,
            )?;
            if inserted {
                synced += 1;
                persist_attachments_from_parsed(
                    conn,
                    &parsed.message_id,
                    &parsed.attachments,
                    maildir_path,
                )?;
                if new_message_ids.len() < NEW_MESSAGE_IDS_CAP {
                    new_message_ids.push(parsed.message_id.clone());
                }
                let d = &parsed.date;
                earliest_date = Some(match &earliest_date {
                    Some(e) if e.as_str() < d.as_str() => e.clone(),
                    _ => d.clone(),
                });
                latest_date = Some(match &latest_date {
                    Some(l) if l.as_str() > d.as_str() => l.clone(),
                    _ => d.clone(),
                });
            }
        }

        let batch_max = *chunk.iter().max().unwrap_or(&0);
        if batch_max > checkpoint_uid {
            checkpoint_uid = batch_max;
            conn.execute(
                "INSERT OR REPLACE INTO sync_state (folder, uidvalidity, last_uid) VALUES (?1, ?2, ?3)",
                params![mailbox, uidvalidity as i64, checkpoint_uid as i64],
            )?;
        }
    }

    conn.execute(
        "UPDATE sync_summary SET
            earliest_synced_date = COALESCE(?1, earliest_synced_date),
            latest_synced_date = COALESCE(?2, latest_synced_date),
            total_messages = (SELECT COUNT(*) FROM messages),
            last_sync_at = datetime('now')
         WHERE id = 1",
        params![earliest_date, latest_date],
    )?;
    release_lock(conn, Some(pid))?;

    let duration_ms = start.elapsed().as_millis() as u64;
    let duration_sec = (duration_ms as f64) / 1000.0;
    let bandwidth = if duration_sec > 0.0 {
        bytes_downloaded as f64 / duration_sec
    } else {
        0.0
    };
    let msg_per_min = if duration_sec > 0.0 {
        (messages_fetched as f64 / duration_sec) * 60.0
    } else {
        0.0
    };

    let r = SyncResult {
        synced,
        messages_fetched,
        bytes_downloaded,
        duration_ms,
        bandwidth_bytes_per_sec: bandwidth,
        messages_per_minute: msg_per_min,
        log_path: log_path_str.clone(),
        early_exit: None,
        new_message_ids: if new_message_ids.is_empty() {
            None
        } else {
            Some(new_message_ids)
        },
    };
    log_sync_metrics(logger, &r);
    Ok(r)
}

/// Run one sync pass using the given transport (real IMAP or test fake).
pub fn run_sync<T: SyncImapTransport>(
    transport: &mut T,
    conn: &mut Connection,
    logger: &SyncFileLogger,
    mailbox: &str,
    maildir_path: &Path,
    exclude_labels: &[String],
    options: &SyncOptions,
) -> Result<SyncResult, RunSyncError> {
    let start = Instant::now();
    let pid_u32 = std::process::id();
    let pid = pid_u32 as i64;

    let prelude = match run_sync_pre_acquire(
        conn,
        logger,
        maildir_path,
        exclude_labels,
        options,
        start,
        pid_u32,
        pid,
    )? {
        RunSyncPreAcquire::Done(r) => return Ok(r),
        RunSyncPreAcquire::AcquireLock(p) => p,
    };

    let lock_result = acquire_lock(conn, pid)?;
    if !lock_result.acquired {
        logger.info("Could not acquire sync lock", None);
        let duration_ms = start.elapsed().as_millis() as u64;
        return Ok(SyncResult::empty(duration_ms, prelude.log_path_str.clone()));
    }
    if lock_result.taken_over {
        logger.info("Recovered stale sync lock", None);
    }

    let sync_result = run_sync_imap_phase(
        transport,
        conn,
        logger,
        mailbox,
        maildir_path,
        &prelude.exclude_lower,
        options,
        start,
        prelude.log_path_str.clone(),
        pid,
    );

    if sync_result.is_err() {
        let _ = release_lock(conn, Some(pid));
    }

    sync_result
}

/// Same as [`run_sync`], but overlaps TCP/TLS connect with SQLite lock acquisition (foreground paths).
pub fn run_sync_with_parallel_imap_connect<F>(
    conn: &mut Connection,
    logger: &SyncFileLogger,
    mailbox: &str,
    maildir_path: &Path,
    exclude_labels: &[String],
    options: &SyncOptions,
    connect: F,
) -> Result<SyncResult, RunSyncError>
where
    F: FnOnce() -> Result<imap::Session<imap::Connection>, RunSyncError> + Send + 'static,
{
    use std::sync::mpsc;

    let start = Instant::now();
    let pid_u32 = std::process::id();
    let pid = pid_u32 as i64;

    let prelude = match run_sync_pre_acquire(
        conn,
        logger,
        maildir_path,
        exclude_labels,
        options,
        start,
        pid_u32,
        pid,
    )? {
        RunSyncPreAcquire::Done(r) => return Ok(r),
        RunSyncPreAcquire::AcquireLock(p) => p,
    };

    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = tx.send(connect());
    });

    let lock_result = acquire_lock(conn, pid)?;
    if !lock_result.acquired {
        logger.info("Could not acquire sync lock", None);
        drop(rx.recv());
        let duration_ms = start.elapsed().as_millis() as u64;
        return Ok(SyncResult::empty(duration_ms, prelude.log_path_str.clone()));
    }
    if lock_result.taken_over {
        logger.info("Recovered stale sync lock", None);
    }

    let connect_result = rx
        .recv()
        .map_err(|_| RunSyncError::Imap("IMAP connect thread disconnected".into()))?;
    let mut session = connect_result?;

    let mut transport = super::transport::RealImapTransport {
        session: &mut session,
    };
    let sync_result = run_sync_imap_phase(
        &mut transport,
        conn,
        logger,
        mailbox,
        maildir_path,
        &prelude.exclude_lower,
        options,
        start,
        prelude.log_path_str.clone(),
        pid,
    );

    if sync_result.is_err() {
        let _ = release_lock(conn, Some(pid));
    }

    sync_result
}

/// Build [`SyncOptions`] after resolving `since` CLI/config into `YYYY-MM-DD`.
pub fn resolve_sync_since_ymd(
    cfg: &Config,
    since_cli: Option<&str>,
) -> Result<String, RunSyncError> {
    let spec = since_cli
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(cfg.sync_default_since.as_str());
    parse_since_to_date(spec).map_err(RunSyncError::Config)
}
