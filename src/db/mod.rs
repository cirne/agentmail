//! SQLite access — file-backed, WAL, FTS5 (mirrors TS `~/db`).

pub mod message_persist;
pub mod schema;

use rusqlite::{Connection, OpenFlags};
use std::io::Write;
use std::path::{Path, PathBuf};

use schema::SCHEMA;
pub use schema::SCHEMA_VERSION;

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

fn read_user_version(path: &Path) -> Result<Option<i32>, DbError> {
    if !path.exists() {
        return Ok(None);
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    apply_connection_pragmas(&conn)?;
    let version = conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i32>(0))?;
    Ok(Some(version))
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct SyncCheckpointRow {
    folder: String,
    uidvalidity: i64,
    last_uid: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct SyncSummarySnapshot {
    earliest_synced_date: Option<String>,
    latest_synced_date: Option<String>,
    target_start_date: Option<String>,
    sync_start_earliest_date: Option<String>,
    last_sync_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct InboxSurfacedRow {
    message_id: String,
    surfaced_at: String,
    scan_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct InboxDecisionRow {
    message_id: String,
    rules_fingerprint: String,
    action: String,
    matched_rule_ids: String,
    note: Option<String>,
    decision_source: String,
    decided_at: String,
    requires_user_action: i64,
    action_summary: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct InboxStateSnapshot {
    scans: Vec<(String, String, String, String, i64, i64)>,
    alerts: Vec<InboxSurfacedRow>,
    reviews: Vec<InboxSurfacedRow>,
    decisions: Vec<InboxDecisionRow>,
}

fn load_sync_checkpoints(conn: &Connection) -> Result<Vec<SyncCheckpointRow>, DbError> {
    let mut stmt = match conn
        .prepare("SELECT folder, uidvalidity, last_uid FROM sync_state ORDER BY folder")
    {
        Ok(stmt) => stmt,
        Err(rusqlite::Error::SqliteFailure(err, _)) if err.extended_code == 1 => {
            return Ok(Vec::new());
        }
        Err(err) => return Err(err.into()),
    };
    let rows = stmt
        .query_map([], |row| {
            Ok(SyncCheckpointRow {
                folder: row.get(0)?,
                uidvalidity: row.get(1)?,
                last_uid: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn load_sync_summary_snapshot(conn: &Connection) -> Result<SyncSummarySnapshot, DbError> {
    let row = match conn.query_row(
            "SELECT earliest_synced_date, latest_synced_date, target_start_date, sync_start_earliest_date, last_sync_at
             FROM sync_summary WHERE id = 1",
            [],
            |row| {
                Ok(SyncSummarySnapshot {
                    earliest_synced_date: row.get(0)?,
                    latest_synced_date: row.get(1)?,
                    target_start_date: row.get(2)?,
                    sync_start_earliest_date: row.get(3)?,
                    last_sync_at: row.get(4)?,
                })
            },
        ) {
        Ok(row) => Some(row),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(rusqlite::Error::SqliteFailure(err, _)) if err.extended_code == 1 => None,
        Err(err) => return Err(err.into()),
    };
    Ok(row.unwrap_or_default())
}

fn query_table_exists(conn: &Connection, table_name: &str) -> Result<bool, DbError> {
    let exists = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table_name],
        |row| row.get::<_, i64>(0),
    )? == 1;
    Ok(exists)
}

/// True when `inbox_decisions` has v17+ columns (schema drift rebuild reads a stale DB).
fn inbox_decisions_has_action_columns(conn: &Connection) -> Result<bool, DbError> {
    if !query_table_exists(conn, "inbox_decisions")? {
        return Ok(false);
    }
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('inbox_decisions') WHERE name IN ('requires_user_action', 'action_summary')",
        [],
        |row| row.get(0),
    )?;
    Ok(n >= 2)
}

fn load_surfaced_rows(
    conn: &Connection,
    table_name: &str,
) -> Result<Vec<InboxSurfacedRow>, DbError> {
    if !query_table_exists(conn, table_name)? {
        return Ok(Vec::new());
    }
    let sql =
        format!("SELECT message_id, surfaced_at, scan_id FROM {table_name} ORDER BY message_id");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], |row| {
            Ok(InboxSurfacedRow {
                message_id: row.get(0)?,
                surfaced_at: row.get(1)?,
                scan_id: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn load_inbox_state_snapshot(conn: &Connection) -> Result<InboxStateSnapshot, DbError> {
    if !query_table_exists(conn, "inbox_scans")? {
        return Ok(InboxStateSnapshot::default());
    }

    let mut scan_stmt = conn.prepare(
        "SELECT scan_id, mode, cutoff_iso, scanned_at, notable_count, candidates_scanned
         FROM inbox_scans
         ORDER BY scan_id",
    )?;
    let scans = scan_stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let alerts = load_surfaced_rows(conn, "inbox_alerts")?;
    let reviews = load_surfaced_rows(conn, "inbox_reviews")?;

    let decisions = if query_table_exists(conn, "inbox_decisions")? {
        if inbox_decisions_has_action_columns(conn)? {
            let mut decisions_stmt = conn.prepare(
                "SELECT message_id, rules_fingerprint, action, matched_rule_ids, note, decision_source, decided_at,
                        requires_user_action, action_summary
                 FROM inbox_decisions
                 ORDER BY message_id, rules_fingerprint",
            )?;
            let rows = decisions_stmt
                .query_map([], |row| {
                    Ok(InboxDecisionRow {
                        message_id: row.get(0)?,
                        rules_fingerprint: row.get(1)?,
                        action: row.get(2)?,
                        matched_rule_ids: row.get(3)?,
                        note: row.get(4)?,
                        decision_source: row.get(5)?,
                        decided_at: row.get(6)?,
                        requires_user_action: row.get(7)?,
                        action_summary: row.get(8)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        } else {
            let mut decisions_stmt = conn.prepare(
                "SELECT message_id, rules_fingerprint, action, matched_rule_ids, note, decision_source, decided_at
                 FROM inbox_decisions
                 ORDER BY message_id, rules_fingerprint",
            )?;
            let rows = decisions_stmt
                .query_map([], |row| {
                    Ok(InboxDecisionRow {
                        message_id: row.get(0)?,
                        rules_fingerprint: row.get(1)?,
                        action: row.get(2)?,
                        matched_rule_ids: row.get(3)?,
                        note: row.get(4)?,
                        decision_source: row.get(5)?,
                        decided_at: row.get(6)?,
                        requires_user_action: 0,
                        action_summary: None,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        }
    } else {
        Vec::new()
    };

    Ok(InboxStateSnapshot {
        scans,
        alerts,
        reviews,
        decisions,
    })
}

fn normalize_inbox_decision_action(action: &str) -> &'static str {
    match action {
        "notify" => "notify",
        "inform" => "inform",
        "ignore" => "ignore",
        _ => "ignore",
    }
}

fn restore_sync_metadata(
    conn: &Connection,
    checkpoints: &[SyncCheckpointRow],
    summary: &SyncSummarySnapshot,
) -> Result<(), DbError> {
    for checkpoint in checkpoints {
        conn.execute(
            "INSERT OR REPLACE INTO sync_state (folder, uidvalidity, last_uid) VALUES (?1, ?2, ?3)",
            (
                &checkpoint.folder,
                checkpoint.uidvalidity,
                checkpoint.last_uid,
            ),
        )?;
    }
    conn.execute(
        "UPDATE sync_summary
         SET earliest_synced_date = COALESCE(?1, (SELECT MIN(date) FROM messages)),
             latest_synced_date = COALESCE(?2, (SELECT MAX(date) FROM messages)),
             target_start_date = ?3,
             sync_start_earliest_date = ?4,
             total_messages = (SELECT COUNT(*) FROM messages),
             last_sync_at = ?5,
             is_running = 0,
             owner_pid = NULL,
             sync_lock_started_at = NULL
         WHERE id = 1",
        (
            summary.earliest_synced_date.as_deref(),
            summary.latest_synced_date.as_deref(),
            summary.target_start_date.as_deref(),
            summary.sync_start_earliest_date.as_deref(),
            summary.last_sync_at.as_deref(),
        ),
    )?;
    Ok(())
}

fn restore_inbox_state(conn: &Connection, inbox: &InboxStateSnapshot) -> Result<(), DbError> {
    for (scan_id, mode, cutoff_iso, scanned_at, notable_count, candidates_scanned) in &inbox.scans {
        conn.execute(
            "INSERT OR REPLACE INTO inbox_scans
             (scan_id, mode, cutoff_iso, scanned_at, notable_count, candidates_scanned)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            (
                scan_id,
                mode,
                cutoff_iso,
                scanned_at,
                notable_count,
                candidates_scanned,
            ),
        )?;
    }
    for row in &inbox.alerts {
        conn.execute(
            "INSERT OR REPLACE INTO inbox_alerts (message_id, surfaced_at, scan_id)
             VALUES (?1, ?2, ?3)",
            (&row.message_id, &row.surfaced_at, &row.scan_id),
        )?;
    }
    for row in &inbox.reviews {
        conn.execute(
            "INSERT OR REPLACE INTO inbox_reviews (message_id, surfaced_at, scan_id)
             VALUES (?1, ?2, ?3)",
            (&row.message_id, &row.surfaced_at, &row.scan_id),
        )?;
    }
    for row in &inbox.decisions {
        let action = normalize_inbox_decision_action(row.action.as_str());
        conn.execute(
            "INSERT OR REPLACE INTO inbox_decisions
             (message_id, rules_fingerprint, action, matched_rule_ids, note, decision_source, decided_at,
              requires_user_action, action_summary)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            (
                &row.message_id,
                &row.rules_fingerprint,
                action,
                &row.matched_rule_ids,
                row.note.as_deref(),
                &row.decision_source,
                &row.decided_at,
                row.requires_user_action,
                row.action_summary.as_deref(),
            ),
        )?;
    }
    Ok(())
}

fn rebuild_temp_db_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(".rebuild");
    PathBuf::from(s)
}

fn maybe_rebuild_stale_db(path: &Path) -> Result<(), DbError> {
    let Some(version) = read_user_version(path)? else {
        return Ok(());
    };
    if version == SCHEMA_VERSION {
        return Ok(());
    }

    let maildir_root = infer_maildir_root(path);
    println!(
        "Detected schema drift (db version {version}, code version {SCHEMA_VERSION}). Rebuilding the local index from maildir cache now; this can take a while..."
    );
    let _ = std::io::stdout().flush();
    let stale_conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    apply_connection_pragmas(&stale_conn)?;
    let checkpoints = load_sync_checkpoints(&stale_conn)?;
    let summary = load_sync_summary_snapshot(&stale_conn)?;
    let inbox = load_inbox_state_snapshot(&stale_conn)?;
    drop(stale_conn);

    let temp_path = rebuild_temp_db_path(path);
    if temp_path.exists() {
        std::fs::remove_file(&temp_path)?;
    }
    let temp_wal_path = sqlite_sidecar_path(&temp_path, "-wal");
    if temp_wal_path.exists() {
        std::fs::remove_file(&temp_wal_path)?;
    }
    let temp_shm_path = sqlite_sidecar_path(&temp_path, "-shm");
    if temp_shm_path.exists() {
        std::fs::remove_file(&temp_shm_path)?;
    }

    let mut conn = open_file_current_schema(&temp_path)?;
    let _ = crate::rebuild_index::rebuild_from_maildir(&mut conn, &maildir_root)?;
    restore_sync_metadata(&conn, &checkpoints, &summary)?;
    restore_inbox_state(&conn, &inbox)?;
    let zmail_home = path
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let cfg = crate::config::load_config(crate::config::LoadConfigOptions {
        home: Some(zmail_home),
        env: None,
    });
    if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        match rt.block_on(crate::inbox::bootstrap::run_post_rebuild_inbox_bootstrap(
            &conn,
            &cfg,
            cfg.inbox_bootstrap_archive_older_than.as_str(),
            false,
        )) {
            Ok(s) => eprintln!(
                "Inbox bootstrap: bulk-archived {} older messages; classified {} (LLM skipped: {})",
                s.bulk_archived_older_than_cutoff,
                s.inbox_candidates_classified,
                s.llm_skipped_no_api_key
            ),
            Err(e) => eprintln!("Inbox bootstrap failed: {e}"),
        }
    }
    conn.execute_batch("PRAGMA wal_checkpoint(FULL); PRAGMA journal_mode=DELETE;")?;
    drop(conn);

    let backup_path = path.with_extension("db.pre-rebuild");
    let backup_wal_path = sqlite_sidecar_path(&backup_path, "-wal");
    let backup_shm_path = sqlite_sidecar_path(&backup_path, "-shm");
    if backup_path.exists() {
        std::fs::remove_file(&backup_path)?;
    }
    if backup_wal_path.exists() {
        std::fs::remove_file(&backup_wal_path)?;
    }
    if backup_shm_path.exists() {
        std::fs::remove_file(&backup_shm_path)?;
    }
    if path.exists() {
        std::fs::rename(path, &backup_path)?;
    }
    let wal_path = sqlite_sidecar_path(path, "-wal");
    if wal_path.exists() {
        let _ = std::fs::rename(&wal_path, &backup_wal_path);
    }
    let shm_path = sqlite_sidecar_path(path, "-shm");
    if shm_path.exists() {
        let _ = std::fs::rename(&shm_path, &backup_shm_path);
    }
    std::fs::rename(&temp_path, path)?;
    if backup_path.exists() {
        let _ = std::fs::remove_file(&backup_path);
    }
    if backup_wal_path.exists() {
        let _ = std::fs::remove_file(&backup_wal_path);
    }
    if backup_shm_path.exists() {
        let _ = std::fs::remove_file(&backup_shm_path);
    }
    Ok(())
}

fn sqlite_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

fn infer_maildir_root(path: &Path) -> PathBuf {
    path.parent()
        .map(|parent| parent.join("maildir"))
        .unwrap_or_else(|| PathBuf::from("maildir"))
}

fn open_file_current_schema(path: &Path) -> Result<Connection, DbError> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )?;
    apply_connection_pragmas(&conn)?;
    apply_schema(&conn)?;
    Ok(conn)
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
    maybe_rebuild_stale_db(path)?;
    open_file_current_schema(path)
}

/// Apply schema + user_version + sync_summary bootstrap + optional ALTER (matches TS `getDb`).
pub fn apply_schema(conn: &Connection) -> Result<(), DbError> {
    conn.execute_batch(SCHEMA)?;
    let _ = conn.execute_batch(
        "DROP INDEX IF EXISTS idx_inbox_handled_message;
         DROP TABLE IF EXISTS inbox_handled;",
    );
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    conn.execute_batch("INSERT OR IGNORE INTO sync_summary (id, total_messages) VALUES (1, 0);")?;

    let mut stmt = conn.prepare("PRAGMA table_info(sync_summary)")?;
    let cols: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    if !cols.iter().any(|c| c == "sync_lock_started_at") {
        conn.execute_batch("ALTER TABLE sync_summary ADD COLUMN sync_lock_started_at TEXT;")?;
    }

    let mut msg_stmt = conn.prepare("PRAGMA table_info(messages)")?;
    let msg_cols: Vec<String> = msg_stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    if !msg_cols.iter().any(|c| c == "is_archived") {
        conn.execute_batch(
            "ALTER TABLE messages ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    if !msg_cols.iter().any(|c| c == "category") {
        conn.execute_batch("ALTER TABLE messages ADD COLUMN category TEXT;")?;
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
        assert!(
            mode == "wal" || mode == "memory",
            "unexpected journal_mode={mode}"
        );
    }

    #[test]
    fn core_tables_exist() {
        let conn = open_memory().unwrap();
        let tables = list_user_tables(&conn).unwrap();
        assert!(tables.iter().any(|n| n == "messages"));
        assert!(tables.iter().any(|n| n == "messages_fts"));
    }

    /// Rebuild path restores `inbox_decisions` including `requires_user_action` / `action_summary`.
    #[test]
    fn inbox_snapshot_roundtrips_action_required_columns() {
        use crate::persist_message;
        use crate::sync::ParsedMessage;

        let conn = open_memory().unwrap();
        apply_schema(&conn).unwrap();
        let parsed = ParsedMessage {
            message_id: "<snap-action@test>".into(),
            from_address: "a@b.com".into(),
            from_name: None,
            to_addresses: vec![],
            cc_addresses: vec![],
            subject: "s".into(),
            date: "2026-01-01T12:00:00Z".into(),
            body_text: "b".into(),
            body_html: None,
            attachments: vec![],
            category: None,
        };
        persist_message(&conn, &parsed, "INBOX", 1, "[]", "x.eml").unwrap();
        conn.execute(
            "INSERT INTO inbox_decisions
             (message_id, rules_fingerprint, action, matched_rule_ids, note, decision_source, requires_user_action, action_summary)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                "<snap-action@test>",
                "fp-snap",
                "inform",
                "[]",
                None::<String>,
                "model",
                1i64,
                "Pay invoice",
            ],
        )
        .unwrap();

        let snap = load_inbox_state_snapshot(&conn).unwrap();
        assert_eq!(snap.decisions.len(), 1);
        assert_eq!(snap.decisions[0].requires_user_action, 1);
        assert_eq!(
            snap.decisions[0].action_summary.as_deref(),
            Some("Pay invoice")
        );

        conn.execute("DELETE FROM inbox_decisions", []).unwrap();
        restore_inbox_state(&conn, &snap).unwrap();

        let (rua, summ): (i64, Option<String>) = conn
            .query_row(
                "SELECT requires_user_action, action_summary FROM inbox_decisions WHERE message_id = '<snap-action@test>'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(rua, 1);
        assert_eq!(summ.as_deref(), Some("Pay invoice"));
    }

    /// Stale DBs (e.g. user_version 16) may have `inbox_decisions` without action columns; drift rebuild must still snapshot.
    #[test]
    fn inbox_snapshot_loads_legacy_decisions_without_action_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE inbox_scans (
                scan_id TEXT PRIMARY KEY,
                mode TEXT NOT NULL,
                cutoff_iso TEXT NOT NULL,
                scanned_at TEXT NOT NULL,
                notable_count INTEGER NOT NULL DEFAULT 0,
                candidates_scanned INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE inbox_decisions (
                message_id TEXT NOT NULL,
                rules_fingerprint TEXT NOT NULL,
                action TEXT NOT NULL,
                matched_rule_ids TEXT NOT NULL DEFAULT '[]',
                note TEXT,
                decision_source TEXT NOT NULL,
                decided_at TEXT NOT NULL,
                PRIMARY KEY (message_id, rules_fingerprint)
            );
            INSERT INTO inbox_scans VALUES ('s1', 'check', '2026-01-01', '2026-01-02', 0, 0);
            INSERT INTO inbox_decisions VALUES ('<legacy@test>', 'fp', 'inform', '[]', NULL, 'model', '2026-01-03');",
        )
        .unwrap();

        let snap = load_inbox_state_snapshot(&conn).unwrap();
        assert_eq!(snap.decisions.len(), 1);
        assert_eq!(snap.decisions[0].message_id, "<legacy@test>");
        assert_eq!(snap.decisions[0].requires_user_action, 0);
        assert!(snap.decisions[0].action_summary.is_none());
    }

    #[test]
    fn open_file_rebuilds_when_user_version_is_stale() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let maildir = data_dir.join("maildir/cur");
        std::fs::create_dir_all(&maildir).unwrap();
        std::fs::write(
            maildir.join("msg1.eml"),
            b"From: a@b.com\r\nSubject: Hi\r\nMessage-ID: <rebuilt@test>\r\nDate: Mon, 1 Jan 2024 12:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nBody",
        )
        .unwrap();

        let db_path = data_dir.join("zmail.db");
        let stale = Connection::open(&db_path).unwrap();
        stale
            .execute_batch("CREATE TABLE stale_only (id INTEGER PRIMARY KEY);")
            .unwrap();
        stale
            .pragma_update(None, "user_version", SCHEMA_VERSION - 1)
            .unwrap();
        drop(stale);

        let conn = open_file(&db_path).unwrap();
        let version: i32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn open_file_rebuild_preserves_sync_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let maildir = data_dir.join("maildir/cur");
        std::fs::create_dir_all(&maildir).unwrap();
        std::fs::write(
            maildir.join("msg1.eml"),
            b"From: a@b.com\r\nSubject: Hi\r\nMessage-ID: <rebuilt-sync@test>\r\nDate: Mon, 1 Jan 2024 12:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nBody",
        )
        .unwrap();

        let db_path = data_dir.join("zmail.db");
        let stale = Connection::open(&db_path).unwrap();
        apply_connection_pragmas(&stale).unwrap();
        apply_schema(&stale).unwrap();
        stale
            .execute(
                "INSERT OR REPLACE INTO sync_state (folder, uidvalidity, last_uid) VALUES ('INBOX', 7, 42)",
                [],
            )
            .unwrap();
        stale
            .execute(
                "UPDATE sync_summary SET target_start_date = '2024-01-01', sync_start_earliest_date = '2025-01-01', last_sync_at = '2026-04-01 18:00:00'",
                [],
            )
            .unwrap();
        stale
            .pragma_update(None, "user_version", SCHEMA_VERSION - 1)
            .unwrap();
        drop(stale);

        let conn = open_file(&db_path).unwrap();
        let state: (i64, i64) = conn
            .query_row(
                "SELECT uidvalidity, last_uid FROM sync_state WHERE folder = 'INBOX'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, (7, 42));
        let summary: (Option<String>, Option<String>, i64, Option<String>) = conn
            .query_row(
                "SELECT target_start_date, sync_start_earliest_date, total_messages, last_sync_at FROM sync_summary WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(summary.0.as_deref(), Some("2024-01-01"));
        assert_eq!(summary.1.as_deref(), Some("2025-01-01"));
        assert_eq!(summary.2, 1);
        assert_eq!(summary.3.as_deref(), Some("2026-04-01 18:00:00"));
    }

    #[test]
    fn open_file_rebuild_clears_inbox_tables_and_bulk_archives_old_mail() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let maildir = data_dir.join("maildir/cur");
        std::fs::create_dir_all(&maildir).unwrap();
        std::fs::write(
            maildir.join("msg1.eml"),
            b"From: a@b.com\r\nSubject: Hi\r\nMessage-ID: <rebuilt-inbox@test>\r\nDate: Mon, 1 Jan 2024 12:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nBody",
        )
        .unwrap();

        let db_path = data_dir.join("zmail.db");
        let stale = Connection::open(&db_path).unwrap();
        apply_connection_pragmas(&stale).unwrap();
        apply_schema(&stale).unwrap();
        stale
            .execute(
                "INSERT INTO messages (message_id, thread_id, folder, uid, labels, category, from_address, from_name, to_addresses, cc_addresses, subject, date, body_text, raw_path, is_archived)
                 VALUES (?1, ?2, ?3, ?4, '[]', NULL, ?5, NULL, '[]', '[]', ?6, ?7, ?8, ?9, 0)",
                (
                    "<rebuilt-inbox@test>",
                    "thread-1",
                    "INBOX",
                    1i64,
                    "a@b.com",
                    "Hi",
                    "2024-01-01T12:00:00.000Z",
                    "Body",
                    "cur/msg1.eml",
                ),
            )
            .unwrap();
        stale
            .execute(
                "INSERT INTO inbox_scans (scan_id, mode, cutoff_iso, scanned_at, notable_count, candidates_scanned)
                 VALUES ('scan-1', 'check', '2024-01-01T00:00:00Z', '2026-04-01 18:00:00', 1, 1)",
                [],
            )
            .unwrap();
        stale
            .execute(
                "INSERT INTO inbox_alerts (message_id, surfaced_at, scan_id)
                 VALUES ('<rebuilt-inbox@test>', '2026-04-01 18:00:00', 'scan-1')",
                [],
            )
            .unwrap();
        stale
            .execute(
                "INSERT INTO inbox_decisions
                 (message_id, rules_fingerprint, action, matched_rule_ids, note, decision_source, decided_at)
                 VALUES ('<rebuilt-inbox@test>', 'fp-1', 'ignore', '[\"r1\"]', 'cached note', 'rule', '2026-04-01 18:30:00')",
                [],
            )
            .unwrap();
        stale
            .pragma_update(None, "user_version", SCHEMA_VERSION - 1)
            .unwrap();
        drop(stale);

        let conn = open_file(&db_path).unwrap();
        let scan_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM inbox_scans", [], |row| row.get(0))
            .unwrap();
        let alert_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM inbox_alerts", [], |row| row.get(0))
            .unwrap();
        let decision_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM inbox_decisions", [], |row| row.get(0))
            .unwrap();
        let archived: i64 = conn
            .query_row(
                "SELECT is_archived FROM messages WHERE message_id = '<rebuilt-inbox@test>'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(scan_count, 0);
        assert_eq!(alert_count, 0);
        assert_eq!(decision_count, 0);
        assert_eq!(archived, 1);
    }

    #[test]
    fn open_file_rebuild_succeeds_while_old_reader_is_open() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let maildir = data_dir.join("maildir/cur");
        std::fs::create_dir_all(&maildir).unwrap();
        std::fs::write(
            maildir.join("msg1.eml"),
            b"From: a@b.com\r\nSubject: Hi\r\nMessage-ID: <reader@test>\r\nDate: Mon, 1 Jan 2024 12:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nBody",
        )
        .unwrap();

        let db_path = data_dir.join("zmail.db");
        let stale = Connection::open(&db_path).unwrap();
        apply_connection_pragmas(&stale).unwrap();
        apply_schema(&stale).unwrap();
        stale
            .pragma_update(None, "user_version", SCHEMA_VERSION - 1)
            .unwrap();

        let reader = Connection::open(&db_path).unwrap();
        let _: i64 = reader
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .unwrap();

        let conn = open_file(&db_path).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        drop(reader);
    }
}
