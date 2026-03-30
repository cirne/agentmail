//! Thread listing (`zmail thread`).

use rusqlite::{Connection, Row};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessageRow {
    pub message_id: String,
    pub from_address: String,
    pub subject: String,
    pub date: String,
}

fn map_row(row: &Row<'_>) -> rusqlite::Result<ThreadMessageRow> {
    Ok(ThreadMessageRow {
        message_id: row.get(0)?,
        from_address: row.get(1)?,
        subject: row.get(2)?,
        date: row.get(3)?,
    })
}

pub fn list_thread_messages(conn: &Connection, thread_id: &str) -> rusqlite::Result<Vec<ThreadMessageRow>> {
    let mut stmt = conn.prepare(
        "SELECT message_id, from_address, subject, date FROM messages WHERE thread_id = ?1 ORDER BY date ASC",
    )?;
    let rows = stmt.query_map([thread_id], map_row)?;
    rows.collect()
}
