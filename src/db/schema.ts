// SQL schema — all tables and FTS5 virtual tables

/** Schema version — bump this integer whenever the schema changes. */
export const SCHEMA_VERSION = 6;

export const SCHEMA = /* sql */ `
  CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id   TEXT NOT NULL UNIQUE,
    thread_id    TEXT NOT NULL,
    folder       TEXT NOT NULL,
    uid          INTEGER NOT NULL,
    labels       TEXT NOT NULL DEFAULT '[]',
    is_noise INTEGER NOT NULL DEFAULT 0,
    from_address TEXT NOT NULL,
    from_name    TEXT,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    subject      TEXT NOT NULL DEFAULT '',
    date         TEXT NOT NULL,
    body_text    TEXT NOT NULL DEFAULT '',
    raw_path     TEXT NOT NULL,
    synced_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- labels: JSON array of label/tag names (Gmail: X-GM-LABELS; generic: optional).
  -- Enables "inbox only", "starred", "archive" filters without re-syncing.

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
    owner_pid            INTEGER
  );

  -- FTS5 full-text search index over message subjects and bodies
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    message_id UNINDEXED,
    subject,
    body_text,
    from_address UNINDEXED,
    date UNINDEXED,
    content='messages',
    content_rowid='id'
  );

  -- Triggers to keep FTS index in sync
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

  -- Indexes for common query patterns
  CREATE INDEX IF NOT EXISTS idx_messages_thread  ON messages(thread_id);
  CREATE INDEX IF NOT EXISTS idx_messages_date    ON messages(date DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_folder  ON messages(folder, uid);
  CREATE INDEX IF NOT EXISTS idx_attachments_msg  ON attachments(message_id);
  CREATE INDEX IF NOT EXISTS idx_messages_noise ON messages(is_noise) WHERE is_noise = 1;
`;
