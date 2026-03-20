import { describe, it, expect, beforeEach } from "vitest";
import type { SqliteDatabase } from "~/db";
import { createTestDb } from "~/db/test-helpers";
import { isProcessAlive, acquireLock, releaseLock } from "./process-lock";

describe("isProcessAlive", () => {
  it("returns true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for a PID that does not exist", () => {
    expect(isProcessAlive(1_073_741_824)).toBe(false);
  });
});

describe("acquireLock", () => {
  let db: SqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("acquires lock on a clean (unlocked) table", async () => {
    const result = await acquireLock(db, "sync_summary", process.pid);
    expect(result.acquired).toBe(true);
    expect(result.takenOver).toBe(false);

    const row = (await (await db.prepare("SELECT is_running, owner_pid FROM sync_summary WHERE id = 1")).get()) as {
      is_running: number;
      owner_pid: number;
    };
    expect(row.is_running).toBe(1);
    expect(row.owner_pid).toBe(process.pid);
  });

  it("blocks when a live process holds the lock", async () => {
    await acquireLock(db, "sync_summary", process.pid);

    const result = await acquireLock(db, "sync_summary", process.pid + 1);
    expect(result.acquired).toBe(false);
    expect(result.takenOver).toBe(false);
  });

  it("takes over a lock from a dead process", async () => {
    const deadPid = 1_073_741_824;

    await (await db.prepare("UPDATE sync_summary SET is_running = 1, owner_pid = ? WHERE id = 1")).run(deadPid);

    const result = await acquireLock(db, "sync_summary", process.pid);
    expect(result.acquired).toBe(true);
    expect(result.takenOver).toBe(true);

    const row = (await (await db.prepare("SELECT owner_pid FROM sync_summary WHERE id = 1")).get()) as {
      owner_pid: number;
    };
    expect(row.owner_pid).toBe(process.pid);
  });

  it("acquires lock when is_running=1 but owner_pid is null (legacy crash)", async () => {
    await db.exec("UPDATE sync_summary SET is_running = 1, owner_pid = NULL WHERE id = 1");

    const result = await acquireLock(db, "sync_summary", process.pid);
    expect(result.acquired).toBe(true);
    expect(result.takenOver).toBe(true);
  });

  it("prevents concurrent acquisition (atomicity)", async () => {
    const pid1 = process.pid;
    const pid2 = process.pid + 1000;

    const result1 = await acquireLock(db, "sync_summary", pid1);
    expect(result1.acquired).toBe(true);

    const result2 = await acquireLock(db, "sync_summary", pid2);
    expect(result2.acquired).toBe(false);
    expect(result2.takenOver).toBe(false);

    await releaseLock(db, "sync_summary", pid1);
    const result3 = await acquireLock(db, "sync_summary", pid2);
    expect(result3.acquired).toBe(true);
  });

  it("handles stale lock takeover under contention", async () => {
    const deadPid = 1_073_741_824;
    const livePid1 = process.pid;
    const livePid2 = process.pid + 1000;

    await (await db.prepare("UPDATE sync_summary SET is_running = 1, owner_pid = ? WHERE id = 1")).run(deadPid);

    const result1 = await acquireLock(db, "sync_summary", livePid1);
    expect(result1.acquired).toBe(true);
    expect(result1.takenOver).toBe(true);

    const result2 = await acquireLock(db, "sync_summary", livePid2);
    expect(result2.acquired).toBe(false);
  });
});

describe("releaseLock", () => {
  let db: SqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("clears is_running and owner_pid", async () => {
    await acquireLock(db, "sync_summary", process.pid);
    await releaseLock(db, "sync_summary");

    const row = (await (await db.prepare("SELECT is_running, owner_pid FROM sync_summary WHERE id = 1")).get()) as {
      is_running: number;
      owner_pid: number | null;
    };
    expect(row.is_running).toBe(0);
    expect(row.owner_pid).toBeNull();
  });

  it("allows re-acquisition after release", async () => {
    await acquireLock(db, "sync_summary", process.pid);
    await releaseLock(db, "sync_summary");

    const result = await acquireLock(db, "sync_summary", process.pid);
    expect(result.acquired).toBe(true);
    expect(result.takenOver).toBe(false);
  });

  it("only releases lock if owner matches (owner-aware release)", async () => {
    const pid1 = process.pid;
    const pid2 = process.pid + 1000;

    await acquireLock(db, "sync_summary", pid1);

    await releaseLock(db, "sync_summary", pid2);

    const row = (await (await db.prepare("SELECT is_running, owner_pid FROM sync_summary WHERE id = 1")).get()) as {
      is_running: number;
      owner_pid: number | null;
    };
    expect(row.is_running).toBe(1);
    expect(row.owner_pid).toBe(pid1);

    await releaseLock(db, "sync_summary", pid1);

    const row2 = (await (await db.prepare("SELECT is_running, owner_pid FROM sync_summary WHERE id = 1")).get()) as {
      is_running: number;
      owner_pid: number | null;
    };
    expect(row2.is_running).toBe(0);
    expect(row2.owner_pid).toBeNull();
  });
});
