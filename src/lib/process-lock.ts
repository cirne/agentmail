import type { SqliteDatabase } from "~/db";
import { logger } from "./logger";

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

export interface LockResult {
  /** Whether the lock was successfully acquired */
  acquired: boolean;
  /** Whether we took over a stale lock from a dead process */
  takenOver: boolean;
}

/**
 * Acquire a lock on a singleton status table (sync_summary).
 * Uses PID-based ownership to detect and recover from crashed processes.
 * Uses atomic transaction-based acquisition to prevent race conditions.
 */
export async function acquireLock(
  db: SqliteDatabase,
  table: "sync_summary",
  currentPid: number
): Promise<LockResult> {
  await db.exec("BEGIN IMMEDIATE TRANSACTION");

  try {
    const row = (await (await db.prepare(`SELECT is_running, owner_pid FROM ${table} WHERE id = 1`)).get()) as
      | { is_running: number; owner_pid: number | null }
      | undefined;

    if (!row) {
      await db.exec("ROLLBACK");
      throw new Error(`${table} singleton row (id=1) does not exist`);
    }

    const wasLocked = !!row.is_running;
    const hadOwner = row.owner_pid !== null;
    const wasTakenOver = wasLocked && (hadOwner || !hadOwner);

    if (wasLocked && hadOwner) {
      if (isProcessAlive(row.owner_pid!)) {
        await db.exec("ROLLBACK");
        return { acquired: false, takenOver: false };
      }
      logger.warn(`Stale lock from dead process ${row.owner_pid}, taking over`, {
        table,
        deadPid: row.owner_pid,
      });
    } else if (wasLocked && !hadOwner) {
      logger.warn(`Stale lock from legacy crash (owner_pid NULL), taking over`, {
        table,
      });
    }

    await (await db.prepare(`UPDATE ${table} SET is_running = 1, owner_pid = ? WHERE id = 1`)).run(
      currentPid
    );

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
 * Release a lock on a singleton status table.
 */
export async function releaseLock(
  db: SqliteDatabase,
  table: "sync_summary",
  ownerPid?: number
): Promise<void> {
  if (ownerPid !== undefined) {
    await db.exec(
      `UPDATE ${table} SET is_running = 0, owner_pid = NULL WHERE id = 1 AND owner_pid = ${ownerPid}`
    );
  } else {
    await db.exec(`UPDATE ${table} SET is_running = 0, owner_pid = NULL WHERE id = 1`);
  }
}
