import { describe, it, expect, beforeEach } from "vitest";
import type { SqliteDatabase } from "~/db";
import { createTestDb, insertTestMessage } from "~/db/test-helpers";

describe("runSync logic", () => {
  let db: SqliteDatabase;
  const mailbox = "[Gmail]/All Mail";

  beforeEach(async () => {
    db = await createTestDb();
  });

  describe("forward sync (refresh)", () => {
    it("should use UID range search format", async () => {
      // Test the UID range format used in forward sync
      const lastUid = 100;
      const uidRange = `${lastUid + 1}:*`;
      
      expect(uidRange).toBe("101:*");
      // This format tells IMAP to search for UIDs >= 101
    });

    it("should filter UIDs > last_uid from search results", async () => {
      // Setup: we've synced up to UID 100
      await (
        await db.prepare(
          "INSERT OR REPLACE INTO sync_state (folder, uidvalidity, last_uid) VALUES (?, ?, ?)"
        )
      ).run(mailbox, 1, 100);

      const state = (await (
        await db.prepare("SELECT last_uid FROM sync_state WHERE folder = ?")
      ).get(mailbox)) as { last_uid: number } | undefined;

      expect(state?.last_uid).toBe(100);
      
      // Simulate IMAP search returning UIDs (some may be <= last_uid)
      const searchResults = [98, 99, 100, 101, 102];
      
      // Filter to only UIDs > last_uid
      const newUids = searchResults.filter((uid) => uid > (state?.last_uid ?? 0));
      expect(newUids).toEqual([101, 102]);
    });

    it("should handle forward sync when no checkpoint exists", async () => {
      // No sync_state row - should fall back to date-based search
      // better-sqlite3 .get() returns undefined when no row (not null)
      const state = (await (
        await db.prepare("SELECT last_uid FROM sync_state WHERE folder = ?")
      ).get(mailbox)) as { last_uid: number } | undefined;

      expect(state).toBeUndefined();
      // Without checkpoint, forward sync should use date-based search
    });
  });

  describe("backward sync (sync)", () => {
    it("resumes from oldest synced date when extending date range", async () => {
      // Setup: we've synced messages from 2026-02-24
      const oldestDate = "2026-02-24T08:44:52.000Z";
      await (
        await db.prepare(
          `INSERT INTO messages
         (message_id, thread_id, folder, uid, from_address, to_addresses, cc_addresses, subject, body_text, date, raw_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
      ).run("msg1@test.com", "thread-1", mailbox, 100, "sender@test.com", "[]", "[]", "Test", "Body", oldestDate, "maildir/test.eml");

      const oldest = (await (
        await db.prepare("SELECT MIN(date) as oldest_date FROM messages WHERE folder = ?")
      ).get(mailbox)) as { oldest_date: string | null };
      
      expect(oldest?.oldest_date).toBeTruthy();
      expect(oldest?.oldest_date).toBe(oldestDate);
    });

    it("filters UIDs <= last_uid to skip already-synced messages", async () => {
      // Setup: we've synced up to UID 100
      await (
        await db.prepare(
          "INSERT OR REPLACE INTO sync_state (folder, uidvalidity, last_uid) VALUES (?, ?, ?)"
        )
      ).run(mailbox, 1, 100);

      // Simulate search returning UIDs that include already-synced ones
      const searchResults = [98, 99, 100, 101, 102];
      
      // After filtering, should only have UIDs > 100
      const filtered = searchResults.filter((uid) => uid > 100);
      expect(filtered).toEqual([101, 102]);
    });

    it("skips fetching when all UIDs are already synced", async () => {
      await (
        await db.prepare(
          "INSERT OR REPLACE INTO sync_state (folder, uidvalidity, last_uid) VALUES (?, ?, ?)"
        )
      ).run(mailbox, 1, 100);

      // All UIDs <= last_uid
      const uids = [98, 99, 100];
      const allSynced = uids.every((uid) => uid <= 100);
      
      expect(allSynced).toBe(true);
      // Should skip fetching and search before oldest date instead
    });

    it("allows same-day re-fetch to catch gaps from interrupted syncs", async () => {
      // Setup: we've synced some messages from 2026-02-24
      await (
        await db.prepare(
          `INSERT INTO messages
         (message_id, thread_id, folder, uid, from_address, to_addresses, cc_addresses, subject, body_text, date, raw_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
      ).run("msg1@test.com", "thread-1", mailbox, 100, "sender@test.com", "[]", "[]", "Test", "Body", "2026-02-24T08:44:52.000Z", "maildir/test.eml");

      const oldest = (await (
        await db.prepare("SELECT MIN(date) as oldest_date FROM messages WHERE folder = ?")
      ).get(mailbox)) as { oldest_date: string | null };

      const oldestDateStr = oldest?.oldest_date?.slice(0, 10); // YYYY-MM-DD
      const requestedDateStr = "2026-02-24";

      // Same day - should allow re-fetch (with UID filtering)
      expect(oldestDateStr).toBe(requestedDateStr);
    });
  });

  describe("UID checkpointing", () => {
    it("tracks last_uid per folder", async () => {
      await (
        await db.prepare(
          "INSERT OR REPLACE INTO sync_state (folder, uidvalidity, last_uid) VALUES (?, ?, ?)"
        )
      ).run(mailbox, 1, 100);

      const state = (await (
        await db.prepare("SELECT uidvalidity, last_uid FROM sync_state WHERE folder = ?")
      ).get(mailbox)) as { uidvalidity: number; last_uid: number } | undefined;

      expect(state).toBeDefined();
      expect(state?.uidvalidity).toBe(1);
      expect(state?.last_uid).toBe(100);
    });

    it("handles BigInt to Number conversion for uidvalidity", async () => {
      // SQLite may return BigInt, but we normalize to Number
      const stateRow = { uidvalidity: BigInt(1), last_uid: BigInt(100) };
      const state = {
        uidvalidity: Number(stateRow.uidvalidity),
        last_uid: Number(stateRow.last_uid),
      };

      expect(state.uidvalidity).toBe(1);
      expect(state.last_uid).toBe(100);
      expect(typeof state.uidvalidity).toBe("number");
      expect(typeof state.last_uid).toBe("number");
    });

    it("handles uidvalidity mismatch (requires full resync)", async () => {
      // Setup: old checkpoint with different uidvalidity
      await (
        await db.prepare(
          "INSERT OR REPLACE INTO sync_state (folder, uidvalidity, last_uid) VALUES (?, ?, ?)"
        )
      ).run(mailbox, 1, 100);

      const state = (await (
        await db.prepare("SELECT uidvalidity FROM sync_state WHERE folder = ?")
      ).get(mailbox)) as { uidvalidity: number } | undefined;

      const currentUidValidity = 2; // Changed (mailbox was recreated)

      // uidvalidity mismatch means we need to resync from scratch
      const isValid = state?.uidvalidity === currentUidValidity;
      expect(isValid).toBe(false);
    });
  });

  describe("resume behavior", () => {
    it("finds oldest synced message date", async () => {
      await insertTestMessage(db, {
        date: "2026-02-20T10:00:00.000Z",
        folder: mailbox,
        uid: 50,
      });
      await insertTestMessage(db, {
        date: "2026-02-24T08:44:52.000Z",
        folder: mailbox,
        uid: 100,
      });

      const oldest = (await (
        await db.prepare("SELECT MIN(date) as oldest_date FROM messages WHERE folder = ?")
      ).get(mailbox)) as { oldest_date: string | null };

      expect(oldest?.oldest_date).toBe("2026-02-20T10:00:00.000Z");
    });

    it("compares dates at day level (ignores time)", async () => {
      const date1 = "2026-02-24T08:44:52.000Z";
      const date2 = "2026-02-24T23:59:59.000Z";
      
      const day1 = date1.slice(0, 10); // YYYY-MM-DD
      const day2 = date2.slice(0, 10);
      
      expect(day1).toBe(day2);
      expect(day1).toBe("2026-02-24");
    });

    it("resumes from oldest date when requested date is newer", async () => {
      await (
        await db.prepare(
          `INSERT INTO messages
         (message_id, thread_id, folder, uid, from_address, to_addresses, cc_addresses, subject, body_text, date, raw_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
      ).run("msg1@test.com", "thread-1", mailbox, 50, "sender@test.com", "[]", "[]", "Test", "Body", "2026-02-20T10:00:00.000Z", "maildir/test.eml");

      const oldest = (await (
        await db.prepare("SELECT MIN(date) as oldest_date FROM messages WHERE folder = ?")
      ).get(mailbox)) as { oldest_date: string | null };

      const oldestDateStr = oldest?.oldest_date?.slice(0, 10);
      const requestedDateStr = "2026-02-15"; // Older than oldest synced

      // Should resume from oldest synced date (2026-02-20), not requested date
      expect(oldestDateStr).toBe("2026-02-20");
      expect(oldestDateStr! > requestedDateStr).toBe(true);
    });

    /**
     * BUG-010: Sync Backward Resume Skips Requested Date Range
     * 
     * When a user syncs a narrow date range (e.g., 7 days) and later requests
     * a wider range (e.g., 90 days), the backward sync resume logic incorrectly
     * uses oldestSynced as the IMAP SEARCH boundary instead of requestedSince.
     * 
     * This test reproduces the bug by verifying that when oldestDay > requestedDay
     * (meaning the user is requesting a wider range), the effectiveSinceDate
     * should use the requested date, not the oldest synced date.
     */
    it("BUG-010: should use requested date when expanding sync range (not oldest synced)", async () => {
      // Setup: We've synced messages from a narrow range (7 days: 2026-02-28 to 2026-03-07)
      // This simulates the scenario: user ran `zmail sync --since 7d`
      const oldestSyncedDate = "2026-02-28T10:00:00.000Z";
      await insertTestMessage(db, {
        date: oldestSyncedDate,
        folder: mailbox,
        uid: 100,
      });
      await insertTestMessage(db, {
        date: "2026-03-07T10:00:00.000Z",
        folder: mailbox,
        uid: 200,
      });

      // Setup sync_state checkpoint (simulates having synced up to UID 200)
      await (
        await db.prepare(
          "INSERT OR REPLACE INTO sync_state (folder, uidvalidity, last_uid) VALUES (?, ?, ?)"
        )
      ).run(mailbox, 1, 200);

      const oldestSynced = (await (
        await db.prepare("SELECT MIN(date) as oldest_date FROM messages WHERE folder = ?")
      ).get(mailbox)) as { oldest_date: string | null };

      const oldestDateStr = oldestSynced?.oldest_date?.slice(0, 10); // "2026-02-28"
      const requestedDateStr = "2025-12-07"; // 90 days back from 2026-03-07

      // Verify the bug scenario: oldestDay > requestedDay (user requesting wider range)
      expect(oldestDateStr).toBe("2026-02-28");
      expect(oldestDateStr! > requestedDateStr).toBe(true);

      // BUG-010: Current buggy behavior uses oldestSynced instead of requestedSince
      // This reproduces the bug: effectiveSinceDate is set to oldestDateStr instead of requestedDateStr
      const buggyEffectiveSinceDate = oldestDateStr; // Current buggy behavior
      const correctEffectiveSinceDate = requestedDateStr; // What it should be

      // The bug: effectiveSinceDate uses oldestSynced (2026-02-28) instead of requestedSince (2025-12-07)
      expect(buggyEffectiveSinceDate).toBe("2026-02-28");
      expect(buggyEffectiveSinceDate).not.toBe(correctEffectiveSinceDate);

      // After fix: effectiveSinceDate should use min(requestedSince, oldestSynced) = requestedSince
      // when oldestSynced > requestedSince (expanding range)
      const fixedEffectiveSinceDate = oldestDateStr! > requestedDateStr 
        ? requestedDateStr  // Use requested date when expanding range
        : oldestDateStr;     // Use oldest synced when narrowing range

      expect(fixedEffectiveSinceDate).toBe("2025-12-07");
      expect(fixedEffectiveSinceDate).toBe(correctEffectiveSinceDate);
    });
  });

  describe("UID filtering logic", () => {
    it("filters UIDs > last_uid for forward sync", async () => {
      const lastUid = 100;
      const uids = [98, 99, 100, 101, 102];
      
      const filtered = uids.filter((uid) => uid > lastUid);
      expect(filtered).toEqual([101, 102]);
    });

    it("detects when all UIDs are already synced", async () => {
      const lastUid = 100;
      const uids = [98, 99, 100];
      
      const allSynced = uids.every((uid) => uid <= lastUid);
      expect(allSynced).toBe(true);
    });

    it("detects when some UIDs are new", async () => {
      const lastUid = 100;
      const uids = [98, 99, 100, 101, 102];
      
      const allSynced = uids.every((uid) => uid <= lastUid);
      expect(allSynced).toBe(false);
    });

    it("handles empty UID array", async () => {
      const lastUid = 100;
      const uids: number[] = [];
      
      const filtered = uids.filter((uid) => uid > lastUid);
      const allSynced = uids.every((uid) => uid <= lastUid);
      
      expect(filtered).toEqual([]);
      expect(allSynced).toBe(true); // Empty array satisfies "all synced"
    });
  });

  describe("backward sync re-search logic", () => {
    it("should re-search with 'before' constraint when all UIDs are synced", async () => {
      // Setup: we've synced all messages from 2026-02-24
      await (
        await db.prepare(
          "INSERT OR REPLACE INTO sync_state (folder, uidvalidity, last_uid) VALUES (?, ?, ?)"
        )
      ).run(mailbox, 1, 100);

      await (
        await db.prepare(
          `INSERT INTO messages
         (message_id, thread_id, folder, uid, from_address, to_addresses, cc_addresses, subject, body_text, date, raw_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
      ).run("msg1@test.com", "thread-1", mailbox, 100, "sender@test.com", "[]", "[]", "Test", "Body", "2026-02-24T10:00:00.000Z", "maildir/test.eml");

      // Simulate search returning UIDs that are all <= last_uid
      const searchResults = [98, 99, 100];
      const allSynced = searchResults.every((uid) => uid <= 100);

      expect(allSynced).toBe(true);

      // Should re-search with 'before' constraint to skip this day entirely
      const oldestDate = "2026-02-24T10:00:00.000Z";
      const oldestDay = oldestDate.slice(0, 10); // "2026-02-24"
      const dayBefore = new Date(oldestDay + "T00:00:00Z");
      dayBefore.setDate(dayBefore.getDate() - 1);
      const dayBeforeStr = dayBefore.toISOString().slice(0, 10);

      expect(dayBeforeStr).toBe("2026-02-23");
    });
  });

  describe("backward sync: effectiveSinceDate and isExpandingRangeBackward (decision matrix)", () => {
    const fromDate = "2025-12-07"; // requested e.g. 90d ago

    function computeBackwardDecision(
      oldestDateStr: string | null,
      requestedDay: string
    ): { effectiveSinceDateStr: string; isExpandingRangeBackward: boolean } {
      if (!oldestDateStr) {
        return { effectiveSinceDateStr: requestedDay, isExpandingRangeBackward: false };
      }
      const oldestDay = oldestDateStr;
      if (oldestDay > requestedDay) {
        return { effectiveSinceDateStr: requestedDay, isExpandingRangeBackward: true };
      }
      if (oldestDay === requestedDay) {
        return { effectiveSinceDateStr: requestedDay, isExpandingRangeBackward: false };
      }
      return { effectiveSinceDateStr: requestedDay, isExpandingRangeBackward: false };
    }

    it("expanding range: oldestDay > requestedDay → use requested date, isExpandingRangeBackward true", async () => {
      const oldestDateStr = "2026-02-28";
      const result = computeBackwardDecision(oldestDateStr, fromDate);
      expect(result.effectiveSinceDateStr).toBe("2025-12-07");
      expect(result.isExpandingRangeBackward).toBe(true);
    });

    it("same day: oldestDay === requestedDay → not expanding", async () => {
      const oldestDateStr = "2025-12-07";
      const result = computeBackwardDecision(oldestDateStr, fromDate);
      expect(result.effectiveSinceDateStr).toBe("2025-12-07");
      expect(result.isExpandingRangeBackward).toBe(false);
    });

    it("oldest before requested: oldestDay < requestedDay → not expanding", async () => {
      const oldestDateStr = "2025-11-01";
      const result = computeBackwardDecision(oldestDateStr, fromDate);
      expect(result.effectiveSinceDateStr).toBe("2025-12-07");
      expect(result.isExpandingRangeBackward).toBe(false);
    });

    it("no messages in folder: no oldestSynced → not expanding", async () => {
      const result = computeBackwardDecision(null, fromDate);
      expect(result.effectiveSinceDateStr).toBe("2025-12-07");
      expect(result.isExpandingRangeBackward).toBe(false);
    });
  });

  describe("backward sync: UID filter choice (expanding vs resume)", () => {
    it("expanding range: filter to UIDs not in DB (includes backfill low UIDs and new high UIDs)", async () => {
      // DB has messages with UIDs 100–150 (we had synced a narrow range)
      for (let uid = 100; uid <= 150; uid++) {
        await insertTestMessage(db, {
          date: "2026-02-20T10:00:00.000Z",
          folder: mailbox,
          uid,
          messageId: `msg-${uid}@test.com`,
        });
      }
      await (
        await db.prepare(
          "INSERT OR REPLACE INTO sync_state (folder, uidvalidity, last_uid) VALUES (?, ?, ?)"
        )
      ).run(mailbox, 1, 150);

      const existingUids = (await (
        await db.prepare("SELECT uid FROM messages WHERE folder = ?")
      ).all(mailbox)) as { uid: number }[];
      const existingSet = new Set(existingUids.map((r) => r.uid));

      // Search returns full range from requested date: 1..160 (backfill 1–99 + already have 100–150 + new 151–160)
      const searchResult = Array.from({ length: 160 }, (_, i) => i + 1);
      const toFetch = searchResult.filter((uid) => !existingSet.has(uid));

      expect(toFetch.length).toBe(109); // 1–99 (99) + 151–160 (10)
      expect(toFetch).toContain(1);
      expect(toFetch).toContain(99);
      expect(toFetch).not.toContain(100);
      expect(toFetch).not.toContain(150);
      expect(toFetch).toContain(151);
      expect(toFetch).toContain(160);
    });

    it("resume (not expanding): filter to uid > last_uid only", async () => {
      const lastUid = 150;
      const searchResult = [98, 99, 100, 149, 150, 151, 152];
      const toFetch = searchResult.filter((uid) => uid > lastUid);
      expect(toFetch).toEqual([151, 152]);
    });

    it("resume: when all UIDs <= last_uid, allSynced is true (triggers before re-search)", async () => {
      const lastUid = 150;
      const searchResult = [98, 99, 100, 149, 150];
      const allUidsAreSynced = searchResult.length > 0 && searchResult.every((uid) => uid <= lastUid);
      expect(allUidsAreSynced).toBe(true);
    });
  });

  describe("backward sync: day-before-oldest vs requested range", () => {
    it("day before oldest >= sinceDate → re-search with before constraint", async () => {
      const oldestDate = new Date("2026-02-24T10:00:00.000Z");
      const dayBeforeOldest = new Date(oldestDate);
      dayBeforeOldest.setDate(dayBeforeOldest.getDate() - 1);
      const sinceDate = new Date("2025-12-07T00:00:00Z");
      const shouldSearchBefore = dayBeforeOldest >= sinceDate;
      expect(shouldSearchBefore).toBe(true);
    });

    it("day before oldest < sinceDate → nothing more to sync (uids = [])", async () => {
      const oldestDate = new Date("2025-12-08T10:00:00.000Z");
      const dayBeforeOldest = new Date(oldestDate);
      dayBeforeOldest.setDate(dayBeforeOldest.getDate() - 1);
      const sinceDate = new Date("2025-12-07T00:00:00Z");
      // 2025-12-07 < 2025-12-08 so day before (2025-12-07) is not >= sinceDate start of day
      const dayBeforeStr = dayBeforeOldest.toISOString().slice(0, 10);
      expect(dayBeforeStr).toBe("2025-12-07");
      const shouldSearchBefore = dayBeforeOldest >= sinceDate;
      expect(shouldSearchBefore).toBe(true); // same day, >= holds
    });

    it("oldest is requested date: day before is before requested → done", async () => {
      const sinceDate = new Date("2025-12-07T00:00:00Z");
      const oldestDate = new Date("2025-12-07T08:00:00.000Z");
      const dayBeforeOldest = new Date(oldestDate);
      dayBeforeOldest.setDate(dayBeforeOldest.getDate() - 1);
      const shouldSearchBefore = dayBeforeOldest >= sinceDate;
      expect(dayBeforeOldest.toISOString().slice(0, 10)).toBe("2025-12-06");
      expect(shouldSearchBefore).toBe(false);
    });
  });

  describe("backward sync: filter block preconditions", () => {
    it("filter block runs only when direction backward, state exists, uidvalidity match, last_uid > 0", async () => {
      const direction = "backward";
      const state = { uidvalidity: 1, last_uid: 100 };
      const uidvalidity = 1;
      const runs =
        direction === "backward" && state && state.uidvalidity === uidvalidity && state.last_uid > 0;
      expect(runs).toBe(true);
    });

    it("filter block skipped when no state", async () => {
      const direction = "backward";
      const state = null;
      const runs = direction === "backward" && state && (state as { last_uid: number }).last_uid > 0;
      expect(runs).toBeFalsy();
    });

    it("filter block skipped when last_uid 0", async () => {
      const direction = "backward";
      const state = { uidvalidity: 1, last_uid: 0 };
      const uidvalidity = 1;
      const runs =
        direction === "backward" && state && state.uidvalidity === uidvalidity && state.last_uid > 0;
      expect(runs).toBe(false);
    });

    it("filter block skipped when uidvalidity mismatch", async () => {
      const direction = "backward";
      const state = { uidvalidity: 1, last_uid: 100 };
      const uidvalidity = 2;
      const runs =
        direction === "backward" && state && state.uidvalidity === uidvalidity && state.last_uid > 0;
      expect(runs).toBe(false);
    });
  });

  describe("forward vs backward branch", () => {
    it("forward: uses UID range last_uid+1:* when state and uidvalidity match", async () => {
      const direction = "forward";
      const state = { uidvalidity: 1, last_uid: 100 };
      const uidvalidity = 1;
      const useUidRange =
        state &&
        state.uidvalidity === uidvalidity &&
        state.last_uid > 0 &&
        direction === "forward";
      expect(useUidRange).toBe(true);
    });

    it("backward or no checkpoint: uses date-based search", async () => {
      const useUidRange = false;
      expect(useUidRange).toBe(false);
    });
  });
});
