//! PID-based sync lock on `sync_summary` (mirrors `src/lib/process-lock.ts`).

use rusqlite::Connection;
use std::time::{SystemTime, UNIX_EPOCH};

/// One hour — same as TS `SYNC_LOCK_TIMEOUT_MS`.
pub const SYNC_LOCK_TIMEOUT_MS: u128 = 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncLockRow {
    pub is_running: i64,
    pub owner_pid: Option<i64>,
    pub sync_lock_started_at: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct LockResult {
    pub acquired: bool,
    pub taken_over: bool,
}

pub fn is_process_alive(pid: i32) -> bool {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid, 0) == 0
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

fn sqlite_utc_ms(value: &str) -> Option<u128> {
    let normalized = if value.contains('T') {
        value.to_string()
    } else {
        value.replace(' ', "T")
    };
    let iso = if normalized.ends_with('Z') {
        normalized
    } else {
        format!("{normalized}Z")
    };
    chrono::DateTime::parse_from_rfc3339(&iso)
        .ok()
        .map(|d| d.timestamp_millis() as u128)
}

pub fn is_lock_stale_by_age(started_at: Option<&str>, now_ms: u128) -> bool {
    let Some(s) = started_at.filter(|s| !s.is_empty()) else {
        return false;
    };
    let Some(started_ms) = sqlite_utc_ms(s) else {
        return false;
    };
    now_ms.saturating_sub(started_ms) > SYNC_LOCK_TIMEOUT_MS
}

pub fn is_sync_lock_held(row: Option<&SyncLockRow>) -> bool {
    let Some(row) = row else {
        return false;
    };
    if row.is_running == 0 {
        return false;
    }
    let Some(pid) = row.owner_pid else {
        return false;
    };
    if !is_process_alive(pid as i32) {
        return false;
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if is_lock_stale_by_age(row.sync_lock_started_at.as_deref(), now) {
        return false;
    }
    true
}

fn read_lock_row(conn: &Connection) -> rusqlite::Result<SyncLockRow> {
    conn.query_row(
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
}

/// Acquire sync lock (BEGIN IMMEDIATE … UPDATE). Simplified vs TS: no SIGTERM kill of stale owner.
pub fn acquire_lock(conn: &mut Connection, current_pid: i64) -> rusqlite::Result<LockResult> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    let row = read_lock_row(&tx)?;
    let was_locked = row.is_running != 0;
    let had_owner = row.owner_pid.is_some();
    let taken_over = was_locked && (had_owner || !had_owner);

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let holdout = was_locked
        && had_owner
        && row
            .owner_pid
            .map(|p| is_process_alive(p as i32))
            .unwrap_or(false)
        && !is_lock_stale_by_age(row.sync_lock_started_at.as_deref(), now_ms);

    if holdout {
        drop(tx);
        return Ok(LockResult {
            acquired: false,
            taken_over: false,
        });
    }

    tx.execute(
        "UPDATE sync_summary SET is_running = 1, owner_pid = ?1, sync_lock_started_at = datetime('now') WHERE id = 1",
        [current_pid],
    )?;
    tx.commit()?;
    Ok(LockResult {
        acquired: true,
        taken_over,
    })
}

pub fn release_lock(conn: &Connection, owner_pid: Option<i64>) -> rusqlite::Result<()> {
    match owner_pid {
        Some(pid) => conn.execute(
            "UPDATE sync_summary SET is_running = 0, owner_pid = NULL, sync_lock_started_at = NULL WHERE id = 1 AND owner_pid = ?1",
            [pid],
        )?,
        None => conn.execute(
            "UPDATE sync_summary SET is_running = 0, owner_pid = NULL, sync_lock_started_at = NULL WHERE id = 1",
            [],
        )?,
    };
    Ok(())
}
