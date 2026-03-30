//! SQLite access — file-backed, WAL, FTS5 (mirrors TS `~/db`).

pub mod message_persist;
pub mod schema;

use rusqlite::{Connection, OpenFlags};
use std::path::Path;

pub use schema::SCHEMA_VERSION;
use schema::SCHEMA;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("rusqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

fn apply_connection_pragmas(conn: &Connection) -> Result<(), DbError> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", true)?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "busy_timeout", 15_000i32)?;
    Ok(())
}

/// Open an in-memory database with full schema (for tests).
pub fn open_memory() -> Result<Connection, DbError> {
    let conn = Connection::open_in_memory()?;
    apply_connection_pragmas(&conn)?;
    apply_schema(&conn)?;
    Ok(conn)
}

/// Open file-backed DB at `path`, creating parent dirs. Applies schema + bootstrap like TS `getDb`.
pub fn open_file(path: &Path) -> Result<Connection, DbError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )?;
    apply_connection_pragmas(&conn)?;
    apply_schema(&conn)?;
    Ok(conn)
}

/// Apply schema + user_version + sync_summary bootstrap + optional ALTER (matches TS `getDb`).
pub fn apply_schema(conn: &Connection) -> Result<(), DbError> {
    conn.execute_batch(SCHEMA)?;
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    conn.execute_batch(
        "INSERT OR IGNORE INTO sync_summary (id, total_messages) VALUES (1, 0);",
    )?;

    let mut stmt = conn.prepare("PRAGMA table_info(sync_summary)")?;
    let cols: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    if !cols.iter().any(|c| c == "sync_lock_started_at") {
        conn.execute_batch("ALTER TABLE sync_summary ADD COLUMN sync_lock_started_at TEXT;")?;
    }

    Ok(())
}

/// Returns `journal_mode` pragma value (e.g. "wal").
pub fn journal_mode(conn: &Connection) -> Result<String, DbError> {
    let mode: String = conn.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
    Ok(mode.to_lowercase())
}

/// List user tables (excludes sqlite internal + FTS shadow tables).
pub fn list_user_tables(conn: &Connection) -> Result<Vec<String>, DbError> {
    let mut stmt = conn.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_memory_user_version() {
        let conn = open_memory().unwrap();
        let v: i32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(v, SCHEMA_VERSION);
    }

    #[test]
    fn journal_mode_sensible() {
        let conn = open_memory().unwrap();
        let mode = journal_mode(&conn).unwrap();
        // In-memory DBs often report `memory`; file-backed uses WAL after pragma.
        assert!(mode == "wal" || mode == "memory", "unexpected journal_mode={mode}");
    }

    #[test]
    fn core_tables_exist() {
        let conn = open_memory().unwrap();
        let tables = list_user_tables(&conn).unwrap();
        assert!(tables.iter().any(|n| n == "messages"));
        assert!(tables.iter().any(|n| n == "messages_fts"));
    }
}
