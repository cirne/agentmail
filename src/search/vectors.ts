import { connect, Index, type Connection, type Table } from "@lancedb/lancedb";
import { mkdirSync } from "fs";
import { config } from "~/lib/config";
import { logger } from "~/lib/logger";

const TABLE_NAME = "message_embeddings";
const INDEX_THRESHOLD = 10_000;

export interface EmbeddingRow extends Record<string, unknown> {
  messageId: string;
  embedding: number[];
  subject: string;
  fromAddress: string;
  date: string;
}

let db: Connection | null = null;
let table: Table | null = null;

async function getVectorDb(): Promise<Connection> {
  if (!db) {
    mkdirSync(config.vectorsPath, { recursive: true });
    db = await connect(config.vectorsPath);
  }
  return db;
}

async function getTable(): Promise<Table | null> {
  if (table) return table;
  const vectorDb = await getVectorDb();
  const tables = await vectorDb.tableNames();
  if (tables.includes(TABLE_NAME)) {
    table = await vectorDb.openTable(TABLE_NAME);
    return table;
  }
  return null;
}

/**
 * Append a batch of embeddings. Append-only — no per-row delete.
 * SQLite embedding_state is the authority on what's indexed; duplicates
 * in LanceDB are harmless since search results join back to SQLite.
 */
export async function addEmbeddingsBatch(rows: EmbeddingRow[]): Promise<void> {
  if (rows.length === 0) return;
  let tbl = await getTable();
  if (!tbl) {
    const vectorDb = await getVectorDb();
    tbl = await vectorDb.createTable(TABLE_NAME, rows);
    table = tbl;
    return;
  }
  await tbl.add(rows);
}

/**
 * Build an IVF_PQ ANN index on the embedding column if one doesn't exist
 * and the table has enough rows to benefit. Safe to call repeatedly.
 */
export async function ensureIndex(): Promise<void> {
  const tbl = await getTable();
  if (!tbl) return;

  const indices = await tbl.listIndices();
  const hasVectorIndex = indices.some(
    (idx) => idx.columns && idx.columns.includes("embedding"),
  );
  if (hasVectorIndex) return;

  const count = await tbl.countRows();
  if (count < INDEX_THRESHOLD) return;

  logger.info("Building ANN index on LanceDB", { rows: count });
  await tbl.createIndex("embedding", {
    config: Index.ivfPq({ distanceType: "cosine" }),
  });
  logger.info("ANN index built");
}

/**
 * Search for similar messages using k-nearest neighbors.
 * Uses ANN index if available, falls back to brute-force.
 */
export async function searchVectors(
  queryEmbedding: number[],
  limit: number = 20,
): Promise<Array<{ messageId: string; score: number }>> {
  const tbl = await getTable();
  if (!tbl) return [];
  const results = await tbl.search(queryEmbedding).limit(limit).toArray();
  return results.map((r: any) => ({
    messageId: r.messageId as string,
    score: r._distance ? 1 / (1 + r._distance) : 0,
  }));
}

/**
 * Check if an embedding exists for a given messageId.
 * Uses SQLite embedding_state as the source of truth.
 */
export function hasEmbedding(
  db: import("bun:sqlite").Database,
  messageId: string,
): boolean {
  const row = db
    .query(
      "SELECT 1 FROM messages WHERE message_id = ? AND embedding_state = 'done'",
    )
    .get(messageId);
  return !!row;
}
