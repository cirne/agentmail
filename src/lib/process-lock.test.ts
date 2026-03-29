import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it, expect, beforeEach } from "vitest";
import type { SqliteDatabase } from "~/db";
import { createTestDb } from "~/db/test-helpers";
import {
  isProcessAlive,
  acquireLock,
  releaseLock,
  isLockStaleByAge,
  isSyncLockHeld,
  SYNC_LOCK_TIMEOUT_MS,
} from "./process-lock";

describe("isProcessAlive", () => {
  it("returns true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for a PID that does not exist", () => {
    expect(isProcessAlive(1_073_741_824)).toBe(false);
  });
});

describe("isLockStaleByAge", () => {
  it("returns false when start time is unknown", () => {
    expect(isLockStaleByAge(null)).toBe(false);
    expect(isLockStaleByAge("")).toBe(false);
  });

  it("returns true when lock started before the timeout window", () => {
    const old = "2000-01-01 00:00:00";
    expect(isLockStaleByAge(old, Date.UTC(2000, 5, 1))).toBe(true);
  });

  it("returns false when lock started within the timeout window", () => {
    const recent = "2026-01-15 11:30:00";
    const startedMs = Date.UTC(2026, 0, 15, 11, 30, 0);
    expect(isLockStaleByAge(recent, startedMs + 30 * 60 * 1000)).toBe(false);
    expect(isLockStaleByAge(recent, startedMs + SYNC_LOCK_TIMEOUT_MS - 1000)).toBe(false);
  });
});

describe("isSyncLockHeld", () => {
  it("returns false when owner PID is dead even if is_running", () => {
    expect(
      isSyncLockHeld({
        is_running: 1,
        owner_pid: 1_073_741_824,
        sync_lock_started_at: "2026-01-01 00:00:00",
      })
    ).toBe(false);
  });

  it("returns false when lock age exceeds timeout", () => {
    expect(
      isSyncLockHeld({
        is_running: 1,
        owner_pid: process.pid,
        sync_lock_started_at: "2000-01-01 00:00:00",
      })
    ).toBe(false);
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

    const row = (await (await db.prepare("SELECT is_running, owner_pid, sync_lock_started_at FROM sync_summary WHERE id = 1")).get()) as {
      is_running: number;
      owner_pid: number;
      sync_lock_started_at: string | null;
    };
    expect(row.is_running).toBe(1);
    expect(row.owner_pid).toBe(process.pid);
    expect(row.sync_lock_started_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
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

  it("takes over when owner is alive but lock exceeded timeout", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
    await delay(400);
    const childPid = child.pid;
    if (childPid === undefined) {
      child.kill();
      return;
    }
    try {
      await (
        await db.prepare(
          "UPDATE sync_summary SET is_running = 1, owner_pid = ?, sync_lock_started_at = ? WHERE id = 1"
        )
      ).run(childPid, "2000-01-01 00:00:00");

      const result = await acquireLock(db, "sync_summary", process.pid);
      expect(result.acquired).toBe(true);
      expect(result.takenOver).toBe(true);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        /* */
      }
    }
  }, 20_000);

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

    const row = (await (await db.prepare("SELECT is_running, owner_pid, sync_lock_started_at FROM sync_summary WHERE id = 1")).get()) as {
      is_running: number;
      owner_pid: number | null;
      sync_lock_started_at: string | null;
    };
    expect(row.is_running).toBe(0);
    expect(row.owner_pid).toBeNull();
    expect(row.sync_lock_started_at).toBeNull();
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
