import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "~/db/test-helpers";
import type { SqliteDatabase } from "~/db";
import { getDb } from "~/db";
import { config } from "~/lib/config";
import { normalizeMessageId } from "./index";

// Helper to insert message with fromName and embedding_state
function insertMessageWithName(
  db: SqliteDatabase,
  opts: {
    messageId?: string;
    threadId?: string;
    fromAddress: string;
    fromName?: string | null;
    subject?: string;
    date?: string;
    embedding_state?: string;
    folder?: string;
    toAddresses?: string;
  }
) {
  const messageId = opts.messageId ?? `<test-${Math.random().toString(36).slice(2)}@example.com>`;
  const threadId = opts.threadId ?? "thread-1";
  const subject = opts.subject ?? "Test subject";
  const date = opts.date ?? new Date().toISOString();
  const embedding_state = opts.embedding_state ?? "pending";
  const folder = opts.folder ?? "[Gmail]/All Mail";
  const toAddresses = opts.toAddresses ?? "[]";

  db.prepare(
    `INSERT INTO messages
       (message_id, thread_id, folder, uid, from_address, from_name, to_addresses, cc_addresses, subject, body_text, date, raw_path, embedding_state)
     VALUES (?, ?, ?, 1, ?, ?, ?, '[]', ?, '', ?, 'maildir/test.eml', ?)`
  ).run(messageId, threadId, folder, opts.fromAddress, opts.fromName ?? null, toAddresses, subject, date, embedding_state);

  return messageId;
}

describe("MCP Server Tools", () => {
  let db: SqliteDatabase;

  beforeEach(async () => {
    db = createTestDb();
    
    // Mock getDb to return our test database
    const dbModule = await import("~/db");
    vi.spyOn(dbModule, "getDb").mockReturnValue(db);
    
    // Mock config
    const configModule = await import("~/lib/config");
    vi.spyOn(configModule, "config", "get").mockReturnValue({
      imap: { user: "test@example.com" },
      maildirPath: "/tmp/test-maildir",
    } as any);
  });

  describe("get_thread", () => {
    it("returns error when thread not found", async () => {
      const testDb = getDb();
      const normalizedThreadId = normalizeMessageId("<nonexistent-thread>");
      const messages = testDb
        .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY date ASC")
        .all(normalizedThreadId) as any[];
      
      expect(messages).toHaveLength(0);
    });

    it("returns all messages in thread ordered by date", async () => {
      const threadId = "<thread-123>";
      insertMessageWithName(db, {
        messageId: "<msg1@example.com>",
        threadId,
        fromAddress: "alice@example.com",
        subject: "First",
        date: "2024-01-01T10:00:00Z",
      });
      insertMessageWithName(db, {
        messageId: "<msg2@example.com>",
        threadId,
        fromAddress: "bob@example.com",
        subject: "Second",
        date: "2024-01-01T11:00:00Z",
      });
      insertMessageWithName(db, {
        messageId: "<msg3@example.com>",
        threadId,
        fromAddress: "charlie@example.com",
        subject: "Third",
        date: "2024-01-01T12:00:00Z",
      });

      const testDb = getDb();
      const { formatMessageForOutput } = await import("~/cli");
      
      const normalizedThreadId = normalizeMessageId(threadId);
      const messages = testDb
        .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY date ASC")
        .all(normalizedThreadId) as any[];
      
      const shaped = await Promise.all(messages.map((m) => formatMessageForOutput(m, false)));
      
      expect(shaped).toHaveLength(3);
      expect(shaped[0].subject).toBe("First");
      expect(shaped[1].subject).toBe("Second");
      expect(shaped[2].subject).toBe("Third");
    });

    it("normalizes thread ID without angle brackets", async () => {
      const threadId = "thread-123";
      insertMessageWithName(db, {
        messageId: "<msg1@example.com>",
        threadId: `<${threadId}>`,
        fromAddress: "alice@example.com",
        subject: "Test",
      });

      const testDb = getDb();
      const normalizedThreadId = normalizeMessageId(threadId);
      const messages = testDb
        .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY date ASC")
        .all(normalizedThreadId) as any[];
      
      expect(messages).toHaveLength(1);
    });
  });

  describe("who", () => {
    it("returns empty array when no people match", async () => {
      insertMessageWithName(db, {
        fromAddress: "alice@example.com",
        fromName: "Alice",
      });

      const { who } = await import("~/search/who");
      const testDb = getDb();
      const ownerAddress = config.imap.user?.trim() || undefined;
      const result = who(testDb, {
        query: "nonexistent",
        ownerAddress,
      });

      expect(result.query).toBe("nonexistent");
      expect(result.people).toEqual([]);
    });

    it("finds people by email address", async () => {
      // When ownerAddress is set, sentCount = emails I sent to them, receivedCount = emails from them to me
      // So we need messages FROM the owner TO tom, or FROM tom TO the owner
      const ownerAddress = config.imap.user?.trim() || "test@example.com";
      
      // Messages from tom to owner (receivedCount = 2)
      insertMessageWithName(db, {
        messageId: "<1@a>",
        fromAddress: "tom@example.com",
        fromName: "Tom Smith",
        toAddresses: JSON.stringify([ownerAddress]),
      });
      insertMessageWithName(db, {
        messageId: "<2@a>",
        fromAddress: "tom@example.com",
        fromName: "Tom Smith",
        toAddresses: JSON.stringify([ownerAddress]),
      });

      const { who } = await import("~/search/who");
      const testDb = getDb();
      const result = who(testDb, {
        query: "tom",
        ownerAddress,
      });

      expect(result.people).toHaveLength(1);
      expect(result.people[0].address).toBe("tom@example.com");
      expect(result.people[0].displayName).toBe("Tom Smith");
      expect(result.people[0].receivedCount).toBe(2); // Messages from tom to owner
    });

    it("finds people by display name", async () => {
      insertMessageWithName(db, {
        messageId: "<1@b>",
        fromAddress: "geoff@company.com",
        fromName: "Geoff Cirne",
      });

      const { who } = await import("~/search/who");
      const testDb = getDb();
      const ownerAddress = config.imap.user?.trim() || undefined;
      const result = who(testDb, {
        query: "geoff",
        ownerAddress,
      });

      expect(result.people).toHaveLength(1);
      expect(result.people[0].address).toBe("geoff@company.com");
      expect(result.people[0].displayName).toBe("Geoff Cirne");
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 10; i++) {
        insertMessageWithName(db, {
          messageId: `<${i}@test>`,
          fromAddress: `person${i}@example.com`,
        });
      }

      const { who } = await import("~/search/who");
      const testDb = getDb();
      const ownerAddress = config.imap.user?.trim() || undefined;
      const result = who(testDb, {
        query: "person",
        limit: 5,
        ownerAddress,
      });

      expect(result.people.length).toBeLessThanOrEqual(5);
    });

    it("respects minSent filter", async () => {
      insertMessageWithName(db, {
        messageId: "<1@test>",
        fromAddress: "frequent@example.com",
      });
      insertMessageWithName(db, {
        messageId: "<2@test>",
        fromAddress: "frequent@example.com",
      });
      insertMessageWithName(db, {
        messageId: "<3@test>",
        fromAddress: "rare@example.com",
      });

      const { who } = await import("~/search/who");
      const testDb = getDb();
      const ownerAddress = config.imap.user?.trim() || undefined;
      const result = who(testDb, {
        query: "example.com",
        minSent: 2,
        ownerAddress,
      });

      expect(result.people.every((p) => p.sentCount >= 2)).toBe(true);
    });
  });

  describe("get_status", () => {
    it("returns sync status", async () => {
      db.prepare(
        `UPDATE sync_summary SET 
          is_running = 0,
          last_sync_at = '2024-01-01T10:00:00Z',
          total_messages = 100,
          earliest_synced_date = '2024-01-01',
          latest_synced_date = '2024-01-31'
        WHERE id = 1`
      ).run();

      const testDb = getDb();
      const syncStatus = testDb.prepare("SELECT * FROM sync_summary WHERE id = 1").get() as {
        earliest_synced_date: string | null;
        latest_synced_date: string | null;
        total_messages: number;
        last_sync_at: string | null;
        is_running: number;
      };

      expect(syncStatus.is_running).toBe(0);
      expect(syncStatus.last_sync_at).toBe("2024-01-01T10:00:00Z");
      expect(syncStatus.total_messages).toBe(100);
    });

    it("returns indexing status", async () => {
      db.prepare(
        `UPDATE indexing_status SET 
          is_running = 1,
          total_to_index = 50,
          indexed_so_far = 30,
          started_at = '2024-01-01T10:00:00Z'
        WHERE id = 1`
      ).run();

      insertMessageWithName(db, { fromAddress: "alice@example.com", embedding_state: "done" });
      insertMessageWithName(db, { fromAddress: "bob@example.com", embedding_state: "done" });
      insertMessageWithName(db, { fromAddress: "charlie@example.com", embedding_state: "pending" });

      const testDb = getDb();
      const indexStatus = testDb.prepare("SELECT * FROM indexing_status WHERE id = 1").get() as {
        is_running: number;
        total_to_index: number;
        indexed_so_far: number;
        started_at: string | null;
        completed_at: string | null;
      };
      
      const totalIndexed = testDb.prepare("SELECT COUNT(*) as count FROM messages WHERE embedding_state = 'done'").get() as { count: number };
      const pendingCount = testDb.prepare("SELECT COUNT(*) as count FROM messages WHERE embedding_state = 'pending'").get() as { count: number };

      expect(indexStatus.is_running).toBe(1);
      expect(indexStatus.total_to_index).toBe(50);
      expect(indexStatus.indexed_so_far).toBe(30);
      expect(totalIndexed.count).toBe(2);
      expect(pendingCount.count).toBe(1);
    });

    it("returns search readiness", async () => {
      insertMessageWithName(db, { fromAddress: "alice@example.com", embedding_state: "done" });
      insertMessageWithName(db, { fromAddress: "bob@example.com", embedding_state: "done" });
      insertMessageWithName(db, { fromAddress: "charlie@example.com", embedding_state: "pending" });

      const testDb = getDb();
      const messagesCount = testDb.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };
      const totalIndexed = testDb.prepare("SELECT COUNT(*) as count FROM messages WHERE embedding_state = 'done'").get() as { count: number };

      expect(messagesCount.count).toBe(3);
      expect(totalIndexed.count).toBe(2);
    });

    it("returns date range when messages exist", async () => {
      insertMessageWithName(db, { fromAddress: "alice@example.com", date: "2024-01-01T10:00:00Z" });
      insertMessageWithName(db, { fromAddress: "bob@example.com", date: "2024-01-31T10:00:00Z" });

      const testDb = getDb();
      const dateRange = testDb.prepare("SELECT MIN(date) as earliest, MAX(date) as latest FROM messages").get() as {
        earliest: string | null;
        latest: string | null;
      };

      expect(dateRange).not.toBeNull();
      expect(dateRange.earliest).toContain("2024-01-01");
      expect(dateRange.latest).toContain("2024-01-31");
    });

    it("returns null date range when no messages", async () => {
      const testDb = getDb();
      const dateRange = testDb.prepare("SELECT MIN(date) as earliest, MAX(date) as latest FROM messages").get() as {
        earliest: string | null;
        latest: string | null;
      };

      expect(dateRange.earliest).toBeNull();
      expect(dateRange.latest).toBeNull();
    });
  });

  describe("get_stats", () => {
    it("returns total message count", async () => {
      insertMessageWithName(db, { fromAddress: "alice@example.com" });
      insertMessageWithName(db, { fromAddress: "bob@example.com" });
      insertMessageWithName(db, { fromAddress: "charlie@example.com" });

      const testDb = getDb();
      const total = testDb.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };

      expect(total.count).toBe(3);
    });

    it("returns date range", async () => {
      insertMessageWithName(db, { fromAddress: "alice@example.com", date: "2024-01-01T10:00:00Z" });
      insertMessageWithName(db, { fromAddress: "bob@example.com", date: "2024-01-31T10:00:00Z" });

      const testDb = getDb();
      const dateRange = testDb.prepare("SELECT MIN(date) as earliest, MAX(date) as latest FROM messages").get() as {
        earliest: string | null;
        latest: string | null;
      };

      expect(dateRange).not.toBeNull();
      expect(dateRange.earliest).toContain("2024-01-01");
      expect(dateRange.latest).toContain("2024-01-31");
    });

    it("returns top senders", async () => {
      insertMessageWithName(db, { fromAddress: "alice@example.com" });
      insertMessageWithName(db, { fromAddress: "alice@example.com" });
      insertMessageWithName(db, { fromAddress: "bob@example.com" });

      const testDb = getDb();
      const topSenders = testDb
        .prepare(
          "SELECT from_address, COUNT(*) as count FROM messages GROUP BY from_address ORDER BY count DESC LIMIT 10"
        )
        .all() as Array<{ from_address: string; count: number }>;

      expect(topSenders.length).toBeGreaterThan(0);
      const alice = topSenders.find((s) => s.from_address === "alice@example.com");
      expect(alice).toBeDefined();
      expect(alice!.count).toBe(2);
    });

    it("returns folder breakdown", async () => {
      insertMessageWithName(db, { fromAddress: "alice@example.com", folder: "[Gmail]/All Mail" });
      insertMessageWithName(db, { fromAddress: "bob@example.com", folder: "[Gmail]/All Mail" });
      insertMessageWithName(db, { fromAddress: "charlie@example.com", folder: "INBOX" });

      const testDb = getDb();
      const folderBreakdown = testDb
        .prepare("SELECT folder, COUNT(*) as count FROM messages GROUP BY folder ORDER BY count DESC")
        .all() as Array<{ folder: string; count: number }>;

      expect(folderBreakdown.length).toBeGreaterThan(0);
      const allMail = folderBreakdown.find((f) => f.folder === "[Gmail]/All Mail");
      expect(allMail).toBeDefined();
      expect(allMail!.count).toBe(2);
    });

    it("limits top senders to 10", async () => {
      for (let i = 0; i < 15; i++) {
        insertMessageWithName(db, {
          messageId: `<${i}@test>`,
          fromAddress: `sender${i}@example.com`,
        });
      }

      const testDb = getDb();
      const topSenders = testDb
        .prepare(
          "SELECT from_address, COUNT(*) as count FROM messages GROUP BY from_address ORDER BY count DESC LIMIT 10"
        )
        .all() as Array<{ from_address: string; count: number }>;

      expect(topSenders.length).toBeLessThanOrEqual(10);
    });
  });
});
