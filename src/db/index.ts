import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { config } from "~/lib/config";
import { logger } from "~/lib/logger";
import { SCHEMA } from "./schema";

let _db: Database | null = null;

interface SchemaColumnRequirement {
  table: string;
  column: string;
}

const REQUIRED_SCHEMA_COLUMNS: SchemaColumnRequirement[] = [
  {
    table: "messages",
    column: "labels",
  },
  {
    table: "messages",
    column: "to_addresses",
  },
  {
    table: "messages",
    column: "cc_addresses",
  },
  {
    table: "messages",
    column: "embedding_state",
  },
  {
    table: "sync_summary",
    column: "owner_pid",
  },
  {
    table: "indexing_status",
    column: "owner_pid",
  },
];

export interface MissingSchemaColumn {
  table: string;
  column: string;
}

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .query(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1"
    )
    .get(tableName);
  return !!row;
}

/**
 * Detect required columns that are missing from existing tables.
 * We only check tables that already exist, so brand-new DBs can bootstrap normally.
 */
export function detectMissingSchemaColumns(db: Database): MissingSchemaColumn[] {
  const missing: MissingSchemaColumn[] = [];

  for (const req of REQUIRED_SCHEMA_COLUMNS) {
    if (!tableExists(db, req.table)) continue;

    const cols = db
      .query(`PRAGMA table_info(${req.table})`)
      .all() as Array<{ name: string }>;
    const hasColumn = cols.some((c) => c.name === req.column);
    if (!hasColumn) {
      missing.push({
        table: req.table,
        column: req.column,
      });
    }
  }

  return missing;
}

export function formatSchemaDriftError(
  dbPath: string,
  dataDir: string,
  missingColumns: MissingSchemaColumn[]
): string {
  const columns = missingColumns.map((c) => `${c.table}.${c.column}`).join(", ");
  return [
    `Detected schema drift in existing DB at ${dbPath}.`,
    `Missing required column(s): ${columns}.`,
    "This project does not run automatic migrations for existing DBs.",
    `Recommended fix: rebuild local data from scratch with "rm -rf ${dataDir}" and sync again.`,
  ].join("\n");
}

export function getDb(): Database {
  if (_db) return _db;

  mkdirSync(dirname(config.dbPath), { recursive: true });

  _db = new Database(config.dbPath, { create: true });
  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA foreign_keys = ON");
  _db.run("PRAGMA synchronous = NORMAL");
  // Allow wait up to 15s for lock (workers and sync share the DB; avoids "database is locked")
  _db.run("PRAGMA busy_timeout = 15000");

  const missingColumns = detectMissingSchemaColumns(_db);
  if (missingColumns.length > 0) {
    const driftMessage = formatSchemaDriftError(config.dbPath, config.dataDir, missingColumns);
    logger.error(driftMessage);
    throw new Error(driftMessage);
  }

  _db.run(SCHEMA);

  // Ensure singleton status rows exist
  _db.run(
    "INSERT OR IGNORE INTO sync_summary (id, total_messages) VALUES (1, 0)"
  );
  _db.run(
    "INSERT OR IGNORE INTO indexing_status (id) VALUES (1)"
  );

  logger.debug("Database opened", { path: config.dbPath });
  return _db;
}

export function closeDb() {
  _db?.close();
  _db = null;
}
