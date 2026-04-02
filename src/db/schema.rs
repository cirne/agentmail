//! SQL schema — mirrors `src/db/schema.ts` in the TypeScript tree.

pub const SCHEMA_VERSION: i32 = 16;

pub const SCHEMA: &str = r#"
  CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id   TEXT NOT NULL UNIQUE,
    thread_id    TEXT NOT NULL,
    folder       TEXT NOT NULL,
    uid          INTEGER NOT NULL,
    labels       TEXT NOT NULL DEFAULT '[]',
    category     TEXT,
    from_address TEXT NOT NULL,
    from_name    TEXT,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    subject      TEXT NOT NULL DEFAULT '',
    date         TEXT NOT NULL,
    body_text    TEXT NOT NULL DEFAULT '',
    raw_path     TEXT NOT NULL,
    is_archived  INTEGER NOT NULL DEFAULT 0,
    synced_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS threads (
    thread_id          TEXT PRIMARY KEY,
    subject            TEXT NOT NULL DEFAULT '',
    participant_count  INTEGER NOT NULL DEFAULT 1,
    message_count      INTEGER NOT NULL DEFAULT 1,
    last_message_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id      TEXT NOT NULL REFERENCES messages(message_id),
    filename        TEXT NOT NULL,
    mime_type       TEXT NOT NULL,
    size            INTEGER NOT NULL DEFAULT 0,
    stored_path     TEXT NOT NULL,
    extracted_text  TEXT
  );

  CREATE TABLE IF NOT EXISTS people (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_name  TEXT,
    aka             TEXT NOT NULL DEFAULT '[]',
    primary_address TEXT NOT NULL,
    addresses       TEXT NOT NULL DEFAULT '[]',
    phone           TEXT,
    title           TEXT,
    company         TEXT,
    urls            TEXT NOT NULL DEFAULT '[]',
    sent_count      INTEGER NOT NULL DEFAULT 0,
    received_count  INTEGER NOT NULL DEFAULT 0,
    mentioned_count INTEGER NOT NULL DEFAULT 0,
    last_contact    TEXT,
    is_noreply      INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_people_name ON people(canonical_name);

  CREATE TABLE IF NOT EXISTS sync_state (
    folder       TEXT PRIMARY KEY,
    uidvalidity  INTEGER NOT NULL,
    last_uid     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sync_windows (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    phase            INTEGER NOT NULL,
    window_start     TEXT NOT NULL,
    window_end       TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    messages_found   INTEGER NOT NULL DEFAULT 0,
    messages_synced  INTEGER NOT NULL DEFAULT 0,
    started_at       TEXT,
    completed_at     TEXT
  );

  CREATE TABLE IF NOT EXISTS sync_summary (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    earliest_synced_date TEXT,
    latest_synced_date   TEXT,
    target_start_date    TEXT,
    sync_start_earliest_date TEXT,
    total_messages       INTEGER NOT NULL DEFAULT 0,
    last_sync_at         TEXT,
    is_running           INTEGER NOT NULL DEFAULT 0,
    owner_pid            INTEGER,
    sync_lock_started_at TEXT
  );

  CREATE TABLE IF NOT EXISTS inbox_scans (
    scan_id            TEXT PRIMARY KEY,
    mode               TEXT NOT NULL,
    cutoff_iso         TEXT NOT NULL,
    scanned_at         TEXT NOT NULL DEFAULT (datetime('now')),
    notable_count      INTEGER NOT NULL DEFAULT 0,
    candidates_scanned INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS inbox_alerts (
    message_id   TEXT NOT NULL REFERENCES messages(message_id),
    surfaced_at  TEXT NOT NULL DEFAULT (datetime('now')),
    scan_id      TEXT NOT NULL REFERENCES inbox_scans(scan_id),
    PRIMARY KEY (message_id)
  );

  CREATE TABLE IF NOT EXISTS inbox_reviews (
    message_id   TEXT NOT NULL REFERENCES messages(message_id),
    surfaced_at  TEXT NOT NULL DEFAULT (datetime('now')),
    scan_id      TEXT NOT NULL REFERENCES inbox_scans(scan_id),
    PRIMARY KEY (message_id)
  );

  CREATE TABLE IF NOT EXISTS inbox_decisions (
    message_id         TEXT NOT NULL REFERENCES messages(message_id),
    rules_fingerprint  TEXT NOT NULL,
    action             TEXT NOT NULL CHECK(action IN ('notify', 'inform', 'ignore')),
    matched_rule_ids   TEXT NOT NULL DEFAULT '[]',
    note               TEXT,
    decision_source    TEXT NOT NULL,
    decided_at         TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (message_id, rules_fingerprint)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    message_id UNINDEXED,
    subject,
    body_text,
    from_address UNINDEXED,
    date UNINDEXED,
    content='messages',
    content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS messages_fts_insert
    AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, message_id, subject, body_text, from_address, date)
      VALUES (new.id, new.message_id, new.subject, new.body_text, new.from_address, new.date);
    END;

  CREATE TRIGGER IF NOT EXISTS messages_fts_delete
    AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, message_id, subject, body_text, from_address, date)
      VALUES ('delete', old.id, old.message_id, old.subject, old.body_text, old.from_address, old.date);
    END;

  CREATE TRIGGER IF NOT EXISTS messages_fts_update
    AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, message_id, subject, body_text, from_address, date)
      VALUES ('delete', old.id, old.message_id, old.subject, old.body_text, old.from_address, old.date);
      INSERT INTO messages_fts(rowid, message_id, subject, body_text, from_address, date)
      VALUES (new.id, new.message_id, new.subject, new.body_text, new.from_address, new.date);
    END;

  CREATE INDEX IF NOT EXISTS idx_messages_thread  ON messages(thread_id);
  CREATE INDEX IF NOT EXISTS idx_messages_date    ON messages(date DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_folder  ON messages(folder, uid);
  CREATE INDEX IF NOT EXISTS idx_messages_archived ON messages(is_archived) WHERE is_archived = 1;
  CREATE INDEX IF NOT EXISTS idx_messages_category ON messages(category) WHERE category IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_attachments_msg  ON attachments(message_id);
  CREATE INDEX IF NOT EXISTS idx_inbox_alerts_message ON inbox_alerts(message_id);
  CREATE INDEX IF NOT EXISTS idx_inbox_reviews_message ON inbox_reviews(message_id);
  CREATE INDEX IF NOT EXISTS idx_inbox_decisions_message ON inbox_decisions(message_id);
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_has_core_objects() {
        assert!(SCHEMA.contains("CREATE TABLE IF NOT EXISTS messages"));
        assert!(SCHEMA.contains("messages_fts"));
    }
}
