import Database from "better-sqlite3";
import { mkdirSync, rmSync } from "fs";
import { dirname } from "path";
import { existsSync } from "fs";
import { config } from "~/lib/config";
import { logger, setLogger, createFileLogger } from "~/lib/logger";
import { SCHEMA, SCHEMA_VERSION } from "./schema";
import { reindexFromMaildir } from "./rebuild";

export type SqliteDatabase = InstanceType<typeof Database>;

let _db: SqliteDatabase | null = null;

/**
 * Check if the database schema version matches the current code version.
 * Returns true if schema needs to be rebuilt (version mismatch or DB doesn't exist).
 * Returns false if schema is up to date or this is a fresh install.
 */
export function checkSchemaVersion(): boolean {
  // Fresh install — no DB file exists, nothing to rebuild
  if (!existsSync(config.dbPath)) {
    return false;
  }

  // Open DB without applying schema to read user_version
  const db = new Database(config.dbPath);
  try {
    const result = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    const userVersion = result?.user_version ?? 0;
    return userVersion !== SCHEMA_VERSION;
  } finally {
    db.close();
  }
}

export function getDb(): SqliteDatabase {
  if (_db) return _db;

  mkdirSync(dirname(config.dbPath), { recursive: true });

  _db = new Database(config.dbPath);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");
  _db.exec("PRAGMA synchronous = NORMAL");
  // Allow wait up to 15s for lock (workers and sync share the DB; avoids "database is locked")
  _db.exec("PRAGMA busy_timeout = 15000");

  _db.exec(SCHEMA);

  // Set schema version so future checks can detect mismatches
  _db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  // Ensure singleton status rows exist
  _db.exec(
    "INSERT OR IGNORE INTO sync_summary (id, total_messages) VALUES (1, 0)"
  );

  logger.debug("Database opened", { path: config.dbPath });
  return _db;
}

export function closeDb() {
  _db?.close();
  _db = null;
}

/**
 * Ensure database schema is up to date. If schema version has changed, rebuilds the index
 * from existing EML files in maildir. This should be called early in any command that uses the DB.
 * 
 * This is a no-op if:
 * - No DB file exists yet (fresh install)
 * - Schema version matches current code version
 * 
 * If schema needs updating, this will:
 * - Delete the old DB
 * - Create a fresh DB with new schema
 * - Re-index all messages from maildir
 */
export async function ensureSchemaUpToDate(): Promise<void> {
  const stale = checkSchemaVersion();
  if (!stale) {
    return; // Schema is up to date or fresh install
  }

  process.stderr.write("Schema updated — rebuilding index from local cache (up to 20s)...\n");
  rmSync(config.dbPath, { force: true });
  rmSync(`${config.dbPath}-shm`, { force: true });
  rmSync(`${config.dbPath}-wal`, { force: true });
  getDb(); // creates fresh DB, sets user_version
  
  // Use sync log file for rebuild logging (same as sync command)
  const fileLogger = createFileLogger("sync");
  fileLogger.writeSeparator(process.pid);
  
  // Replace global logger with file logger for rebuild operations
  const restoreLogger = setLogger(fileLogger);
  
  try {
    fileLogger.info("Schema rebuild starting");
    const result = await reindexFromMaildir();
    fileLogger.info("Schema rebuild complete", { parsed: result.parsed });
    process.stderr.write(`Rebuild complete (${result.parsed} messages re-indexed).\n`);
  } finally {
    fileLogger.close();
    restoreLogger(); // Restore original logger
  }
}
