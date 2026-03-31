//! Thread listing (`zmail thread`).

use crate::ids::resolve_thread_id;
use rusqlite::{Connection, Row};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessageRow {
    pub message_id: String,
    pub from_address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    pub subject: String,
    pub date: String,
}

fn map_row(row: &Row<'_>) -> rusqlite::Result<ThreadMessageRow> {
    Ok(ThreadMessageRow {
        message_id: row.get(0)?,
        from_address: row.get(1)?,
        from_name: row.get(2)?,
        subject: row.get(3)?,
        date: row.get(4)?,
    })
}

pub fn list_thread_messages(
    conn: &Connection,
    thread_id: &str,
) -> rusqlite::Result<Vec<ThreadMessageRow>> {
    let Some(tid) = resolve_thread_id(conn, thread_id)? else {
        return Ok(Vec::new());
    };
    let mut stmt = conn.prepare(
        "SELECT message_id, from_address, from_name, subject, date FROM messages WHERE thread_id = ?1 ORDER BY date ASC",
    )?;
    let rows = stmt.query_map([&tid], map_row)?;
    rows.collect()
}
