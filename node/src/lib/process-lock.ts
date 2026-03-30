import { setTimeout as delay } from "node:timers/promises";
import type { SqliteDatabase } from "~/db";
import { logger } from "./logger";

/** If a sync holds the lock longer than this, another sync may take it and signal the owner. */
export const SYNC_LOCK_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Check if a process with the given PID is still alive.
 * Uses signal 0 (doesn't actually kill, just checks existence).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = check existence, doesn't kill
    return true;
  } catch {
    return false; // ESRCH = no such process
  }
}

/** Row fields used for sync lock decisions (sync_summary). */
export type SyncLockRow = {
  is_running: number;
  owner_pid: number | null;
  sync_lock_started_at: string | null;
};

function sqliteUtcMs(value: string): number {
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const iso = normalized.endsWith("Z") ? normalized : `${normalized}Z`;
  return Date.parse(iso);
}

/**
 * True if the lock was taken longer than SYNC_LOCK_TIMEOUT_MS ago.
 * Unknown/null start time is not treated as expired (PID checks still apply).
 */
export function isLockStaleByAge(startedAt: string | null, nowMs: number = Date.now()): boolean {
  if (startedAt == null || startedAt === "") return false;
  const startedMs = sqliteUtcMs(startedAt);
  if (Number.isNaN(startedMs)) return false;
  return nowMs - startedMs > SYNC_LOCK_TIMEOUT_MS;
}

/**
 * Fast path for skipping IMAP connect: another sync truly holds the lock.
 * Does not use a DB transaction — races are OK; acquireLock is authoritative.
 */
export function isSyncLockHeld(row: SyncLockRow | undefined): boolean {
  if (!row || !row.is_running) return false;
  if (row.owner_pid == null) return false;
  if (!isProcessAlive(row.owner_pid)) return false;
  if (isLockStaleByAge(row.sync_lock_started_at)) return false;
  return true;
}

async function terminateHungSyncOwner(pid: number): Promise<void> {
  if (pid === process.pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await delay(2000);
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ESRCH */
    }
  }
}

export interface LockResult {
  /** Whether the lock was successfully acquired */
  acquired: boolean;
  /** Whether we took over a stale lock from a dead process */
  takenOver: boolean;
}

async function acquireLockWithDepth(
  db: SqliteDatabase,
  table: "sync_summary",
  currentPid: number,
  depth: number
): Promise<LockResult> {
  await db.exec("BEGIN IMMEDIATE TRANSACTION");

  try {
    const row = (await (
      await db.prepare(
        `SELECT is_running, owner_pid, sync_lock_started_at FROM ${table} WHERE id = 1`
      )
    ).get()) as SyncLockRow | undefined;

    if (!row) {
      await db.exec("ROLLBACK");
      throw new Error(`${table} singleton row (id=1) does not exist`);
    }

    const wasLocked = !!row.is_running;
    const hadOwner = row.owner_pid !== null;
    const wasTakenOver = wasLocked && (hadOwner || !hadOwner);

    const holdout =
      wasLocked &&
      hadOwner &&
      isProcessAlive(row.owner_pid!) &&
      !isLockStaleByAge(row.sync_lock_started_at);

    if (holdout) {
      await db.exec("ROLLBACK");
      return { acquired: false, takenOver: false };
    }

    const needKill =
      wasLocked &&
      hadOwner &&
      isProcessAlive(row.owner_pid!) &&
      isLockStaleByAge(row.sync_lock_started_at) &&
      depth === 0;

    if (needKill) {
      const victim = row.owner_pid!;
      await db.exec("ROLLBACK");
      logger.warn("Sync lock exceeded timeout; stopping prior sync process", {
        table,
        victimPid: victim,
        timeoutMs: SYNC_LOCK_TIMEOUT_MS,
      });
      await terminateHungSyncOwner(victim);
      return acquireLockWithDepth(db, table, currentPid, depth + 1);
    }

    if (wasLocked && hadOwner && !isProcessAlive(row.owner_pid!)) {
      logger.warn(`Stale lock from dead process ${row.owner_pid}, taking over`, {
        table,
        deadPid: row.owner_pid,
      });
    } else if (wasLocked && !hadOwner) {
      logger.warn(`Stale lock from legacy crash (owner_pid NULL), taking over`, {
        table,
      });
    } else if (
      wasLocked &&
      hadOwner &&
      isProcessAlive(row.owner_pid!) &&
      isLockStaleByAge(row.sync_lock_started_at) &&
      depth > 0
    ) {
      logger.warn("Taking over sync lock after prior owner exceeded timeout", {
        table,
        priorPid: row.owner_pid,
      });
    }

    await (
      await db.prepare(
        `UPDATE ${table} SET is_running = 1, owner_pid = ?, sync_lock_started_at = datetime('now') WHERE id = 1`
      )
    ).run(currentPid);

    await db.exec("COMMIT");

    return {
      acquired: true,
      takenOver: wasTakenOver,
    };
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Acquire a lock on a singleton status table (sync_summary).
 * Uses PID-based ownership to detect crashed owners, and a 1h timeout to recover from hung syncs.
 * Uses atomic transaction-based acquisition to prevent race conditions.
 */
export async function acquireLock(
  db: SqliteDatabase,
  table: "sync_summary",
  currentPid: number
): Promise<LockResult> {
  return acquireLockWithDepth(db, table, currentPid, 0);
}

/**
 * Release a lock on a singleton status table.
 */
export async function releaseLock(
  db: SqliteDatabase,
  table: "sync_summary",
  ownerPid?: number
): Promise<void> {
  if (ownerPid !== undefined) {
    await db.exec(
      `UPDATE ${table} SET is_running = 0, owner_pid = NULL, sync_lock_started_at = NULL WHERE id = 1 AND owner_pid = ${ownerPid}`
    );
  } else {
    await db.exec(
      `UPDATE ${table} SET is_running = 0, owner_pid = NULL, sync_lock_started_at = NULL WHERE id = 1`
    );
  }
}
