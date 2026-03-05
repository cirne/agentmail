/**
 * Indexing orchestrator (ADR-020).
 * Single-thread, async-pipelined architecture.
 * Multiple embedding batches are in-flight concurrently (OpenAI API is the bottleneck,
 * not CPU), while only this thread touches SQLite (no cross-thread lock contention).
 * Uses PID-based lock to prevent concurrent indexing runs.
 */

import type { Database } from "bun:sqlite";
import { getDb } from "~/db";
import { logger } from "~/lib/logger";
import { config } from "~/lib/config";
import { acquireLock, releaseLock } from "~/lib/process-lock";
import { embedBatch, prepareTextForEmbedding } from "./embeddings";
import { addEmbeddingsBatch, ensureIndex, type EmbeddingRow } from "./vectors";

export interface IndexingResult {
  indexed: number;
  skipped: number;
  failed: number;
  durationMs: number;
  messagesPerMinute: number;
}

export const BATCH_SIZE = 100;

/** Number of concurrent in-flight embedding batches. */
function getConcurrency(): number {
  const envValue = process.env.INDEXER_CONCURRENCY;
  if (envValue) {
    const count = parseInt(envValue, 10);
    if (!isNaN(count) && count > 0) return count;
  }
  return 2;
}

export interface MessageRow {
  id: number;
  message_id: string;
  subject: string;
  body_text: string;
  from_address: string;
  date: string;
}

/**
 * Atomically claim a batch of pending messages.
 */
export function claimBatch(db: Database, size: number): MessageRow[] {
  return db.transaction(() => {
    const rows = db
      .query(
        `SELECT id, message_id, subject, body_text, from_address, date
         FROM messages
         WHERE embedding_state = 'pending'
         ORDER BY date DESC
         LIMIT ?`
      )
      .all(size) as MessageRow[];

    if (rows.length > 0) {
      const ids = rows.map((r) => r.id).join(",");
      db.run(
        `UPDATE messages SET embedding_state = 'claimed' WHERE id IN (${ids})`
      );
    }

    return rows;
  })();
}

export function isSyncRunning(db: Database): boolean {
  const row = db
    .query("SELECT is_running FROM sync_summary WHERE id = 1")
    .get() as { is_running: number } | null;
  return row?.is_running === 1;
}

export function resetStaleClaims(db: Database): number {
  const row = db
    .query("SELECT COUNT(*) as c FROM messages WHERE embedding_state = 'claimed'")
    .get() as { c: number };
  const count = row.c;
  if (count > 0) {
    db.run(
      `UPDATE messages SET embedding_state = 'pending' WHERE embedding_state = 'claimed'`
    );
    logger.info("Reset stale claims", { count });
  }
  return count;
}

/**
 * Process a single batch: embed via OpenAI, batch-insert to LanceDB, update SQLite.
 */
async function processBatch(
  db: Database,
  batch: MessageRow[],
): Promise<{ indexed: number; failed: number }> {
  const texts = batch.map((m) =>
    prepareTextForEmbedding(m.subject, m.body_text),
  );

  try {
    const embeddings = await embedBatch(texts);

    const rows: EmbeddingRow[] = [];
    for (let i = 0; i < batch.length; i++) {
      rows.push({
        messageId: batch[i].message_id,
        embedding: embeddings[i],
        subject: batch[i].subject,
        fromAddress: batch[i].from_address,
        date: batch[i].date,
      });
    }

    await addEmbeddingsBatch(rows);

    const ids = batch.map((m) => m.id).join(",");
    db.run(
      `UPDATE messages SET embedding_state = 'done' WHERE id IN (${ids})`,
    );

    return { indexed: batch.length, failed: 0 };
  } catch (err) {
    logger.error("Embedding batch failed", { error: String(err) });
    const ids = batch.map((m) => m.id).join(",");
    db.run(
      `UPDATE messages SET embedding_state = 'failed' WHERE id IN (${ids})`,
    );
    return { indexed: 0, failed: batch.length };
  }
}

/**
 * Index messages with async-pipelined concurrency.
 * Claims batches serially (fast, single-writer), but runs N embedding API calls
 * in parallel. This saturates the OpenAI rate limit without any thread contention.
 */
export async function indexMessages(): Promise<IndexingResult> {
  if (!config.openai.apiKey) {
    logger.warn("OPENAI_API_KEY not set, skipping indexing");
    return { indexed: 0, skipped: 0, failed: 0, durationMs: 0, messagesPerMinute: 0 };
  }

  const startTime = Date.now();
  const db = getDb();

  const lockResult = acquireLock(db, "indexing_status", process.pid);
  if (!lockResult.acquired) {
    logger.info("Indexing already running, skipping");
    return { indexed: 0, skipped: 0, failed: 0, durationMs: Date.now() - startTime, messagesPerMinute: 0 };
  }

  if (lockResult.takenOver) {
    logger.info("Recovered from crashed indexing, resetting stale claims");
  }

  resetStaleClaims(db);

  db.run(
    `UPDATE indexing_status SET
      total_to_index = (SELECT COUNT(*) FROM messages WHERE embedding_state = 'pending'),
      indexed_so_far = 0,
      failed = 0,
      started_at = datetime('now'),
      completed_at = NULL
    WHERE id = 1`
  );

  const concurrency = getConcurrency();
  logger.info("Indexing started", { concurrency });

  let totalIndexed = 0;
  let totalFailed = 0;

  // Pool of in-flight batch promises
  const inFlight: Set<Promise<void>> = new Set();

  let emptyPolls = 0;
  let done = false;

  while (!done) {
    // Fill up to concurrency limit with in-flight batches
    while (inFlight.size < concurrency) {
      const batch = claimBatch(db, BATCH_SIZE);

      if (batch.length === 0) {
        if (isSyncRunning(db)) {
          // Sync still running — break inner loop and wait below
          break;
        }
        // Sync done and queue empty — we're done after in-flight batches finish
        done = true;
        break;
      }

      emptyPolls = 0;

      const batchPromise = processBatch(db, batch).then((result) => {
        totalIndexed += result.indexed;
        totalFailed += result.failed;

        // Update progress
        db.run(
          `UPDATE indexing_status SET indexed_so_far = ?, failed = ? WHERE id = 1`,
          [totalIndexed, totalFailed]
        );

        inFlight.delete(batchPromise);
      });

      inFlight.add(batchPromise);
    }

    if (inFlight.size > 0) {
      // Wait for at least one batch to complete before claiming more
      await Promise.race(inFlight);
    } else if (!done) {
      // No in-flight work and sync still running — poll
      emptyPolls++;
      const delay = Math.min(500 * emptyPolls, 2000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    if ((totalIndexed + totalFailed) % 500 === 0 && totalIndexed + totalFailed > 0) {
      logger.info("Indexing progress", {
        indexed: totalIndexed,
        failed: totalFailed,
      });
    }
  }

  // Wait for remaining in-flight batches
  if (inFlight.size > 0) {
    await Promise.all(inFlight);
  }

  if (totalIndexed > 0) {
    try {
      await ensureIndex();
    } catch (err) {
      logger.warn("Failed to build ANN index", { error: String(err) });
    }
  }

  db.run(
    `UPDATE indexing_status SET
      indexed_so_far = ?,
      failed = ?,
      completed_at = datetime('now')
    WHERE id = 1`,
    [totalIndexed, totalFailed],
  );

  releaseLock(db, "indexing_status");

  const durationMs = Date.now() - startTime;
  const messagesPerMinute =
    durationMs > 0 ? Math.round((totalIndexed / durationMs) * 60000) : 0;

  logger.info("Indexing complete", {
    indexed: totalIndexed,
    failed: totalFailed,
    durationMs,
    messagesPerMinute,
  });

  return {
    indexed: totalIndexed,
    skipped: 0,
    failed: totalFailed,
    durationMs,
    messagesPerMinute,
  };
}
