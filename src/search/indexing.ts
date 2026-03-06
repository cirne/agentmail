/**
 * Indexing orchestrator (ADR-020).
 * Single-thread, async-pipelined architecture.
 * Multiple embedding batches are in-flight concurrently (OpenAI API is the bottleneck,
 * not CPU), while only this thread touches SQLite (no cross-thread lock contention).
 * Uses PID-based lock to prevent concurrent indexing runs.
 */

import type { SqliteDatabase } from "~/db";
import { getDb } from "~/db";
import { logger } from "~/lib/logger";
import { config } from "~/lib/config";
import { acquireLock, releaseLock } from "~/lib/process-lock";
import { embedBatch, prepareTextForEmbedding } from "./embeddings";
import { addEmbeddingsBatch, ensureIndex, type EmbeddingRow } from "./vectors";
import { withTimer } from "~/lib/timer";

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
  return 5; // Increased from 2 to 5 for better throughput (OPP-010)
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
export function claimBatch(db: SqliteDatabase, size: number): MessageRow[] {
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT id, message_id, subject, body_text, from_address, date
         FROM messages
         WHERE embedding_state = 'pending'
         ORDER BY date DESC
         LIMIT ?`
      )
      .all(size) as MessageRow[];

    if (rows.length > 0) {
      const ids = rows.map((r) => r.id).join(",");
      db.exec(
        `UPDATE messages SET embedding_state = 'claimed' WHERE id IN (${ids})`
      );
    }

    return rows;
  })();
}

export function isSyncRunning(db: SqliteDatabase): boolean {
  const row = db
    .prepare("SELECT is_running FROM sync_summary WHERE id = 1")
    .get() as { is_running: number } | null;
  return row?.is_running === 1;
}

export function resetStaleClaims(db: SqliteDatabase): number {
  const row = db
    .prepare("SELECT COUNT(*) as c FROM messages WHERE embedding_state = 'claimed'")
    .get() as { c: number };
  const count = row.c;
  if (count > 0) {
    db.exec(
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
  db: SqliteDatabase,
  batch: MessageRow[],
): Promise<{ indexed: number; failed: number }> {
  const batchStartMs = Date.now();
  const texts = batch.map((m) =>
    prepareTextForEmbedding(m.subject, m.body_text),
  );

  let embeddingsAdded = false;
  try {
    const { result: embeddings, durationMs: embedMs } = await withTimer(
      "embed",
      () => embedBatch(texts)
    );

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

    const { durationMs: addEmbeddingsMs } = await withTimer(
      "add_embeddings",
      () => addEmbeddingsBatch(rows)
    );
    embeddingsAdded = true;

    // Use parameterized query instead of string interpolation
    const ids = batch.map((m) => m.id);
    const placeholders = ids.map(() => "?").join(",");
    const { durationMs: ftsUpdateMs } = await withTimer(
      "fts_update",
      async () => {
        db.prepare(
          `UPDATE messages SET embedding_state = 'done' WHERE id IN (${placeholders})`
        ).run(...ids);
      }
    );
    
    const batchMs = Date.now() - batchStartMs;
    logger.debug("Batch processed", {
      batchSize: batch.length,
      embedMs,
      addEmbeddingsMs,
      ftsUpdateMs,
      totalBatchMs: batchMs,
    });

    return { indexed: batch.length, failed: 0 };
  } catch (err) {
    // Log detailed error information
    const errorDetails = {
      error: err instanceof Error ? err.message : String(err),
      errorType: err instanceof Error ? err.constructor.name : typeof err,
      stack: err instanceof Error ? err.stack : undefined,
      batchSize: batch.length,
      messageIds: batch.slice(0, 5).map((m) => m.message_id), // Log first 5 message IDs
      embeddingsAdded,
    };
    logger.error("Embedding batch failed", errorDetails);
    
    // Only mark as failed if embeddings weren't successfully added to LanceDB.
    // If embeddings were added but UPDATE failed, try to update state anyway.
    // This handles the case where addEmbeddingsBatch succeeded but UPDATE threw.
    if (embeddingsAdded) {
      // Embeddings are in LanceDB, so they're actually indexed.
      // Try to update SQLite state - if this fails, messages remain in 'claimed'
      // and will be reset to 'pending' on next run (harmless since embeddings are cached).
      try {
        const ids = batch.map((m) => m.id);
        const placeholders = ids.map(() => "?").join(",");
        db.prepare(
          `UPDATE messages SET embedding_state = 'done' WHERE id IN (${placeholders})`
        ).run(...ids);
        logger.warn("Recovered from UPDATE failure after embeddings were added", {
          batchSize: batch.length,
        });
        return { indexed: batch.length, failed: 0 };
      } catch (updateErr) {
        logger.error("Failed to update state after embeddings were added", {
          batchSize: batch.length,
          error: String(updateErr),
        });
        // Messages remain in 'claimed' state - will be reset to 'pending' on next run
        // Since embeddings are in LanceDB, they're effectively indexed
        return { indexed: batch.length, failed: 0 };
      }
    } else {
      // Embeddings weren't added, so mark as failed
      const ids = batch.map((m) => m.id);
      const placeholders = ids.map(() => "?").join(",");
      db.prepare(
        `UPDATE messages SET embedding_state = 'failed' WHERE id IN (${placeholders})`
      ).run(...ids);
      return { indexed: 0, failed: batch.length };
    }
  }
}

/**
 * Index messages with async-pipelined concurrency.
 * Claims batches serially (fast, single-writer), but runs N embedding API calls
 * in parallel. This saturates the OpenAI rate limit without any thread contention.
 */
export async function indexMessages(options?: {
  /**
   * Promise that resolves when sync has finished inserting messages.
   * While unresolved, the indexer keeps polling for new work.
   * When resolved (or not provided), the indexer exits once the queue is empty.
   */
  syncDone?: Promise<void>;
  /**
   * For testing: inject a DB instance instead of calling getDb().
   * Also bypasses the OPENAI_API_KEY check when provided alongside _processBatch.
   */
  db?: SqliteDatabase;
  /**
   * For testing: replace the real processBatch (which calls OpenAI + LanceDB)
   * with a fake that returns immediately. When provided, skips the API key check.
   */
  _processBatch?: (db: SqliteDatabase, batch: MessageRow[]) => Promise<{ indexed: number; failed: number }>;
}): Promise<IndexingResult> {
  if (!config.openai.apiKey && !options?._processBatch) {
    logger.warn("OPENAI_API_KEY not set, skipping indexing");
    return { indexed: 0, skipped: 0, failed: 0, durationMs: 0, messagesPerMinute: 0 };
  }

  const startTime = Date.now();
  const db = options?.db ?? getDb();
  const batchFn = options?._processBatch ?? processBatch;

  const lockResult = acquireLock(db, "indexing_status", process.pid);
  if (!lockResult.acquired) {
    logger.info("Indexing already running, skipping");
    return { indexed: 0, skipped: 0, failed: 0, durationMs: Date.now() - startTime, messagesPerMinute: 0 };
  }

  if (lockResult.takenOver) {
    logger.info("Recovered from crashed indexing, resetting stale claims");
  }

  resetStaleClaims(db);

  db.exec(
    `UPDATE indexing_status SET
      total_to_index = (SELECT COUNT(*) FROM messages WHERE embedding_state = 'pending'),
      indexed_so_far = 0,
      started_at = datetime('now'),
      completed_at = NULL
    WHERE id = 1`
  );

  const concurrency = getConcurrency();
  logger.info("Indexing started", { concurrency, batchSize: BATCH_SIZE });

  // Track when sync signals it's done inserting messages.
  // If no signal is provided (standalone indexing), treat sync as already done.
  let syncFinished = !options?.syncDone;
  options?.syncDone?.then(() => { syncFinished = true; }).catch(() => { syncFinished = true; });

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
        if (!syncFinished) {
          // Sync still running — more messages may arrive, keep waiting
          break;
        }
        // Sync done and queue empty — drain in-flight then exit
        done = true;
        break;
      }

      emptyPolls = 0;
      
      logger.debug("Batch start", {
        concurrency,
        inFlight: inFlight.size,
        batchSize: batch.length,
      });

      const batchPromise = batchFn(db, batch).then((result) => {
        totalIndexed += result.indexed;
        totalFailed += result.failed;

        // Update progress
        db.prepare(
          `UPDATE indexing_status SET indexed_so_far = ? WHERE id = 1`
        ).run(totalIndexed);

        inFlight.delete(batchPromise);
      }).catch((err) => {
        // If the promise handler itself throws, log it but don't crash
        logger.error("Batch promise handler error", { error: String(err) });
        inFlight.delete(batchPromise);
        throw err; // Re-throw to ensure Promise.all/race properly handles it
      });

      inFlight.add(batchPromise);
    }

    if (inFlight.size > 0) {
      // Wait for at least one batch to complete before claiming more
      // If done=true was just set, wait for ALL batches to ensure proper completion
      if (done) {
        // Queue is empty and sync is done - wait for all remaining batches to finish
        await Promise.all(inFlight);
        // All batches completed, exit the loop
        break;
      } else {
        // Normal case: wait for one batch to complete, then continue
        await Promise.race(inFlight);
      }
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

  // Final safety check: ensure all batches completed (should be empty if done=true path was taken)
  if (inFlight.size > 0) {
    logger.warn("Unexpected batches still in flight after loop exit", { count: inFlight.size });
    await Promise.all(inFlight);
    logger.info("All batches completed");
  }

  if (totalIndexed > 0) {
    try {
      await ensureIndex();
    } catch (err) {
      logger.warn("Failed to build ANN index", { error: String(err) });
    }
  }

  db.prepare(
    `UPDATE indexing_status SET
      indexed_so_far = ?,
      completed_at = datetime('now')
    WHERE id = 1`
  ).run(totalIndexed);

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
