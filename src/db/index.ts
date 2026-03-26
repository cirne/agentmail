import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "fs";
import { dirname } from "path";
import { existsSync } from "fs";
import { config } from "~/lib/config";
import { logger, setLogger, createFileLogger } from "~/lib/logger";
import { SCHEMA, SCHEMA_VERSION } from "./schema";
import { reindexFromMaildir } from "./rebuild";
import { wrapNodeSqlite } from "./node-sqlite-adapter";
import type { SqliteDatabase } from "./sqlite-types";

export type { SqliteDatabase, SqliteStatement, SqliteRunResult } from "./sqlite-types";

let _db: SqliteDatabase | null = null;

function openRawDatabase(path: string): DatabaseSync {
  return new DatabaseSync(path);
}

/** Rows read from sync_state before wiping the DB (rebuild / schema bump). */
type PreservedSyncStateRow = { folder: string; uidvalidity: number; last_uid: number };

function readSyncStateForPreserve(dbPath: string): PreservedSyncStateRow[] {
  if (!existsSync(dbPath)) return [];
  const raw = openRawDatabase(dbPath);
  try {
    const rows = raw.prepare("SELECT folder, uidvalidity, last_uid FROM sync_state").all() as PreservedSyncStateRow[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  } finally {
    raw.close();
  }
}

async function restorePreservedSyncState(db: SqliteDatabase, preserved: PreservedSyncStateRow[]): Promise<void> {
  if (preserved.length === 0) return;
  const upsert = await db.prepare(
    "INSERT OR REPLACE INTO sync_state (folder, uidvalidity, last_uid) VALUES (?, ?, ?)"
  );
  for (const row of preserved) {
    const maxRow = (await (await db.prepare("SELECT MAX(uid) AS m FROM messages WHERE folder = ?")).get(
      row.folder
    )) as { m: number | bigint | null } | undefined;
    const maxFromIndex = maxRow?.m != null ? Number(maxRow.m) : 0;
    const lastUid = Math.max(row.last_uid, maxFromIndex);
    await upsert.run(row.folder, row.uidvalidity, lastUid);
  }
}

/**
 * Check if the database schema version matches the current code version.
 * Returns true if schema needs to be rebuilt (version mismatch or DB doesn't exist).
 * Returns false if schema is up to date or this is a fresh install.
 */
export async function checkSchemaVersion(): Promise<boolean> {
  if (!existsSync(config.dbPath)) {
    return false;
  }

  const raw = openRawDatabase(config.dbPath);
  try {
    const result = raw.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    const userVersion = result?.user_version ?? 0;
    return userVersion !== SCHEMA_VERSION;
  } finally {
    raw.close();
  }
}

export async function getDb(): Promise<SqliteDatabase> {
  if (_db) return _db;

  mkdirSync(dirname(config.dbPath), { recursive: true });

  const raw = openRawDatabase(config.dbPath);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("PRAGMA synchronous = NORMAL");
  raw.exec("PRAGMA busy_timeout = 15000");

  raw.exec(SCHEMA);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  raw.exec("INSERT OR IGNORE INTO sync_summary (id, total_messages) VALUES (1, 0)");

  _db = wrapNodeSqlite(raw);

  logger.debug("Database opened", { path: config.dbPath });
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_db) {
    await _db.close();
    _db = null;
  }
}

/**
 * Delete the SQLite files, open a fresh DB at the current schema, and reindex from maildir/cur.
 * Shared by schema-drift handling and `zmail rebuild-index`.
 */
async function runRebuildIndexFromMaildir(stderrIntro: string): Promise<void> {
  process.stderr.write(stderrIntro);
  await closeDb();
  const preservedSyncState = readSyncStateForPreserve(config.dbPath);
  rmSync(config.dbPath, { force: true });
  rmSync(`${config.dbPath}-shm`, { force: true });
  rmSync(`${config.dbPath}-wal`, { force: true });
  await getDb();

  const fileLogger = createFileLogger("sync");
  fileLogger.writeSeparator(process.pid);

  const restoreLogger = setLogger(fileLogger);

  try {
    fileLogger.info("Schema rebuild starting");
    const result = await reindexFromMaildir();
    if (preservedSyncState.length > 0) {
      const db = await getDb();
      await restorePreservedSyncState(db, preservedSyncState);
      fileLogger.info("Restored sync_state after rebuild", { folders: preservedSyncState.length });
    }
    fileLogger.info("Schema rebuild complete", { parsed: result.parsed });
    process.stderr.write(`Rebuild complete (${result.parsed} messages re-indexed).\n`);
  } finally {
    fileLogger.close();
    restoreLogger();
  }
}

/**
 * Ensure database schema is up to date. If schema version has changed, rebuilds the index
 * from existing EML files in maildir. This should be called early in any command that uses the DB.
 */
export async function ensureSchemaUpToDate(): Promise<void> {
  const stale = await checkSchemaVersion();
  if (!stale) {
    return;
  }

  await runRebuildIndexFromMaildir("Schema updated — rebuilding index from local cache (up to 20s)...\n");
}

/**
 * Wipe SQLite and reindex from local maildir — same steps as a schema version bump, without changing SCHEMA_VERSION.
 * For dev/test when the index is suspect; does not re-fetch from IMAP.
 */
export async function rebuildLocalIndexFromMaildirForced(): Promise<void> {
  await runRebuildIndexFromMaildir("Rebuilding index from local maildir cache (up to 20s)...\n");
}
