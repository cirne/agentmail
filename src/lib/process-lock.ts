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
 *
 * @param db Database instance
 * @param table Table name ('sync_summary')
 * @param currentPid Current process PID
 * @returns Lock result indicating if acquired and if takeover occurred
 */
export function acquireLock(
  db: SqliteDatabase,
  table: "sync_summary",
  currentPid: number
): LockResult {
  // Use BEGIN IMMEDIATE to acquire exclusive lock on the database
  // This ensures atomic read-modify-write semantics and prevents race conditions
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  
  try {
    const row = db
      .prepare(`SELECT is_running, owner_pid FROM ${table} WHERE id = 1`)
      .get() as { is_running: number; owner_pid: number | null } | null;

    if (!row) {
      db.exec("ROLLBACK");
      throw new Error(`${table} singleton row (id=1) does not exist`);
    }

    const wasLocked = !!row.is_running;
    const hadOwner = row.owner_pid !== null;
    const wasTakenOver = wasLocked && (hadOwner || !hadOwner); // Legacy crash (owner_pid NULL) is also a takeover

    // Check if lock is held by a live process
    if (wasLocked && hadOwner) {
      if (isProcessAlive(row.owner_pid!)) {
        // Genuinely still running - release transaction and return failure
        db.exec("ROLLBACK");
        return { acquired: false, takenOver: false };
      }
      // Dead process — we'll take over (log after commit)
      logger.warn(`Stale lock from dead process ${row.owner_pid}, taking over`, {
        table,
        deadPid: row.owner_pid,
      });
    } else if (wasLocked && !hadOwner) {
      // Legacy crash state: is_running=1 but owner_pid IS NULL
      // This is also a takeover scenario
      logger.warn(`Stale lock from legacy crash (owner_pid NULL), taking over`, {
        table,
      });
    }

    // With BEGIN IMMEDIATE, we have exclusive access, so we can safely update
    // No need for guarded WHERE clause since no other process can interfere
    db.prepare(
      `UPDATE ${table} SET is_running = 1, owner_pid = ? WHERE id = 1`
    ).run(currentPid);

    db.exec("COMMIT");
    
    return {
      acquired: true,
      takenOver: wasTakenOver,
    };
  } catch (error) {
    // Ensure transaction is rolled back on any error
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Release a lock on a singleton status table.
 * Only releases if the current process owns the lock (owner-aware release).
 *
 * @param db Database instance
 * @param table Table name ('sync_summary')
 * @param ownerPid Process ID that should own the lock. If provided, only releases if owner matches.
 */
export function releaseLock(
  db: SqliteDatabase,
  table: "sync_summary",
  ownerPid?: number
): void {
  if (ownerPid !== undefined) {
    // Owner-aware release: only release if we own the lock
    db.exec(`UPDATE ${table} SET is_running = 0, owner_pid = NULL WHERE id = 1 AND owner_pid = ${ownerPid}`);
  } else {
    // Legacy behavior: unconditional release (for backward compatibility)
    db.exec(`UPDATE ${table} SET is_running = 0, owner_pid = NULL WHERE id = 1`);
  }
}
