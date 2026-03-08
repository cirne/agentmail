import { describe, it, expect, beforeEach } from "vitest";
import type { SqliteDatabase } from "~/db";
import { createTestDb } from "~/db/test-helpers";
import { isProcessAlive, acquireLock, releaseLock } from "./process-lock";

describe("isProcessAlive", () => {
  it("returns true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for a PID that does not exist", () => {
    // PID 2^30 is almost certainly not running
    expect(isProcessAlive(1_073_741_824)).toBe(false);
  });
});

describe("acquireLock", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  it("acquires lock on a clean (unlocked) table", () => {
    const result = acquireLock(db, "sync_summary", process.pid);
    expect(result.acquired).toBe(true);
    expect(result.takenOver).toBe(false);

    const row = db.prepare("SELECT is_running, owner_pid FROM sync_summary WHERE id = 1").get() as {
      is_running: number;
      owner_pid: number;
    };
    expect(row.is_running).toBe(1);
    expect(row.owner_pid).toBe(process.pid);
  });

  it("blocks when a live process holds the lock", () => {
    // First acquire with the current PID
    acquireLock(db, "sync_summary", process.pid);

    // Second acquire with the same (live) PID should fail
    const result = acquireLock(db, "sync_summary", process.pid + 1);
    expect(result.acquired).toBe(false);
    expect(result.takenOver).toBe(false);
  });

  it("takes over a lock from a dead process", () => {
    const deadPid = 1_073_741_824;

    // Simulate a crashed process holding the lock
    db.prepare("UPDATE sync_summary SET is_running = 1, owner_pid = ? WHERE id = 1").run(deadPid);

    const result = acquireLock(db, "sync_summary", process.pid);
    expect(result.acquired).toBe(true);
    expect(result.takenOver).toBe(true);

    const row = db.prepare("SELECT owner_pid FROM sync_summary WHERE id = 1").get() as {
      owner_pid: number;
    };
    expect(row.owner_pid).toBe(process.pid);
  });

  it("acquires lock when is_running=1 but owner_pid is null (legacy crash)", () => {
    db.exec("UPDATE sync_summary SET is_running = 1, owner_pid = NULL WHERE id = 1");

    const result = acquireLock(db, "sync_summary", process.pid);
    expect(result.acquired).toBe(true);
    expect(result.takenOver).toBe(true);
  });

  it("prevents concurrent acquisition (atomicity)", () => {
    // Simulate two processes trying to acquire the same lock
    const pid1 = process.pid;
    const pid2 = process.pid + 1000; // Different PID
    
    // First process acquires lock
    const result1 = acquireLock(db, "sync_summary", pid1);
    expect(result1.acquired).toBe(true);
    
    // Second process should fail (lock is held by live process)
    const result2 = acquireLock(db, "sync_summary", pid2);
    expect(result2.acquired).toBe(false);
    expect(result2.takenOver).toBe(false);
    
    // Release and verify second process can now acquire
    releaseLock(db, "sync_summary", pid1);
    const result3 = acquireLock(db, "sync_summary", pid2);
    expect(result3.acquired).toBe(true);
  });

  it("handles stale lock takeover under contention", () => {
    const deadPid = 1_073_741_824;
    const livePid1 = process.pid;
    const livePid2 = process.pid + 1000;
    
    // Set up stale lock
    db.prepare("UPDATE sync_summary SET is_running = 1, owner_pid = ? WHERE id = 1").run(deadPid);
    
    // First process should take over stale lock
    const result1 = acquireLock(db, "sync_summary", livePid1);
    expect(result1.acquired).toBe(true);
    expect(result1.takenOver).toBe(true);
    
    // Second process should fail (lock now held by live process)
    const result2 = acquireLock(db, "sync_summary", livePid2);
    expect(result2.acquired).toBe(false);
  });
});

describe("releaseLock", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  it("clears is_running and owner_pid", () => {
    acquireLock(db, "sync_summary", process.pid);
    releaseLock(db, "sync_summary");

    const row = db.prepare("SELECT is_running, owner_pid FROM sync_summary WHERE id = 1").get() as {
      is_running: number;
      owner_pid: number | null;
    };
    expect(row.is_running).toBe(0);
    expect(row.owner_pid).toBeNull();
  });

  it("allows re-acquisition after release", () => {
    acquireLock(db, "sync_summary", process.pid);
    releaseLock(db, "sync_summary");

    const result = acquireLock(db, "sync_summary", process.pid);
    expect(result.acquired).toBe(true);
    expect(result.takenOver).toBe(false);
  });

  it("only releases lock if owner matches (owner-aware release)", () => {
    const pid1 = process.pid;
    const pid2 = process.pid + 1000;
    
    // Acquire lock with pid1
    acquireLock(db, "sync_summary", pid1);
    
    // Try to release with wrong PID - should not release
    releaseLock(db, "sync_summary", pid2);
    
    // Lock should still be held
    const row = db.prepare("SELECT is_running, owner_pid FROM sync_summary WHERE id = 1").get() as {
      is_running: number;
      owner_pid: number | null;
    };
    expect(row.is_running).toBe(1);
    expect(row.owner_pid).toBe(pid1);
    
    // Release with correct PID - should release
    releaseLock(db, "sync_summary", pid1);
    
    const row2 = db.prepare("SELECT is_running, owner_pid FROM sync_summary WHERE id = 1").get() as {
      is_running: number;
      owner_pid: number | null;
    };
    expect(row2.is_running).toBe(0);
    expect(row2.owner_pid).toBeNull();
  });
});
