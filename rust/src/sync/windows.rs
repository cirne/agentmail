//! UID / date helpers for sync planning (mirrors `src/sync/index.test.ts` expectations).

use rusqlite::{Connection, OptionalExtension};

/// IMAP UID search range for forward sync: `last_uid + 1:*`.
pub fn forward_uid_range(last_uid: i64) -> String {
    format!("{}:*", last_uid + 1)
}

/// Keep only UIDs strictly greater than `last_uid`.
pub fn filter_uids_after(uids: &[i64], last_uid: i64) -> Vec<i64> {
    uids.iter().copied().filter(|&u| u > last_uid).collect()
}

pub fn oldest_message_date_for_folder(
    conn: &Connection,
    folder: &str,
) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT MIN(date) FROM messages WHERE folder = ?1",
        [folder],
        |row| row.get::<_, Option<String>>(0),
    )
}

/// Compare two ISO date strings at calendar day (YYYY-MM-DD prefix).
pub fn same_calendar_day(a: &str, b: &str) -> bool {
    let da = a.chars().take(10).collect::<String>();
    let db = b.chars().take(10).collect::<String>();
    da == db && da.len() == 10
}

/// Load `last_uid` for folder from `sync_state`, if any.
pub fn last_uid_for_folder(conn: &Connection, folder: &str) -> Result<Option<i64>, rusqlite::Error> {
    conn.query_row(
        "SELECT last_uid FROM sync_state WHERE folder = ?1",
        [folder],
        |row| row.get(0),
    )
    .optional()
}
