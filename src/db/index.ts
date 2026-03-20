import Database from "better-sqlite3";
import { mkdirSync, rmSync } from "fs";
import { dirname } from "path";
import { existsSync } from "fs";
import { config } from "~/lib/config";
import { logger, setLogger, createFileLogger } from "~/lib/logger";
import { SCHEMA, SCHEMA_VERSION } from "./schema";
import { reindexFromMaildir } from "./rebuild";
import { wrapBetterSqlite3 } from "./better-sqlite-adapter";
import type { SqliteDatabase } from "./sqlite-types";

export type { SqliteDatabase, SqliteStatement, SqliteRunResult } from "./sqlite-types";

let _db: SqliteDatabase | null = null;

function openRawDatabase(path: string): InstanceType<typeof Database> {
  return new Database(path);
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

  _db = wrapBetterSqlite3(raw);

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
 * Ensure database schema is up to date. If schema version has changed, rebuilds the index
 * from existing EML files in maildir. This should be called early in any command that uses the DB.
 */
export async function ensureSchemaUpToDate(): Promise<void> {
  const stale = await checkSchemaVersion();
  if (!stale) {
    return;
  }

  process.stderr.write("Schema updated — rebuilding index from local cache (up to 20s)...\n");
  await closeDb();
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
    fileLogger.info("Schema rebuild complete", { parsed: result.parsed });
    process.stderr.write(`Rebuild complete (${result.parsed} messages re-indexed).\n`);
  } finally {
    fileLogger.close();
    restoreLogger();
  }
}
