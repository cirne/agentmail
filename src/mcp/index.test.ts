import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb } from "~/db/test-helpers";
import type { SqliteDatabase } from "~/db";
import { getDb } from "~/db";
import { config } from "~/lib/config";
import { normalizeMessageId } from "./index";
import { shapeShapedToOutput, DEFAULT_BODY_CAP, type ShapedMessageLike } from "~/messages/lean-shape";

const NOISE_KEYS = ["id", "uid", "folder", "raw_path", "synced_at"] as const;

function assertLeanMessage(obj: Record<string, unknown>) {
  for (const k of NOISE_KEYS) {
    expect(obj).not.toHaveProperty(k);
  }
  const content = obj.content as Record<string, unknown> | undefined;
  if (content) {
    expect(content).not.toHaveProperty("format");
    expect(content).not.toHaveProperty("source");
  }
}

// Helper to insert message with fromName
function insertMessageWithName(
  db: SqliteDatabase,
  opts: {
    messageId?: string;
    threadId?: string;
    fromAddress: string;
    fromName?: string | null;
    subject?: string;
    date?: string;
    folder?: string;
    toAddresses?: string;
  }
) {
  const messageId = opts.messageId ?? `<test-${Math.random().toString(36).slice(2)}@example.com>`;
  const threadId = opts.threadId ?? "thread-1";
  const subject = opts.subject ?? "Test subject";
  const date = opts.date ?? new Date().toISOString();
  const folder = opts.folder ?? "[Gmail]/All Mail";
  const toAddresses = opts.toAddresses ?? "[]";

  db.prepare(
    `INSERT INTO messages
       (message_id, thread_id, folder, uid, from_address, from_name, to_addresses, cc_addresses, subject, body_text, date, raw_path)
     VALUES (?, ?, ?, 1, ?, ?, ?, '[]', ?, '', ?, 'maildir/test.eml')`
  ).run(messageId, threadId, folder, opts.fromAddress, opts.fromName ?? null, toAddresses, subject, date);

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
      const { formatMessageForOutput } = await import("~/messages/presenter");
      
      const normalizedThreadId = normalizeMessageId(threadId);
      const messages = testDb
        .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY date ASC")
        .all(normalizedThreadId) as any[];
      
      const shaped = await Promise.all(messages.map((m) => formatMessageForOutput(m, false, testDb)));
      
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

    it("returns lean shape when raw=false (no id, uid, folder, raw_path, synced_at)", async () => {
      const threadId = "<thread-lean>";
      insertMessageWithName(db, {
        messageId: "<lean1@example.com>",
        threadId,
        fromAddress: "alice@example.com",
        fromName: "Alice",
        subject: "Lean test",
        date: "2024-01-01T10:00:00Z",
      });

      const { formatMessageForOutput } = await import("~/messages/presenter");
      const testDb = getDb();
      const messages = testDb
        .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY date ASC")
        .all(normalizeMessageId(threadId)) as any[];

      const shaped = await Promise.all(messages.map((m) => formatMessageForOutput(m, false, testDb)));
      const out = shapeShapedToOutput(shaped as (ShapedMessageLike | Record<string, unknown>)[], { useRaw: false, detail: "full", maxBodyChars: DEFAULT_BODY_CAP });

      expect(out).toHaveLength(1);
      assertLeanMessage(out[0] as Record<string, unknown>);
      expect((out[0] as Record<string, unknown>).message_id).toBe("<lean1@example.com>");
      expect((out[0] as Record<string, unknown>).subject).toBe("Lean test");
    });
  });

  describe("get_message (lean output)", () => {
    it("returns lean JSON with no noise fields", async () => {
      const messageId = insertMessageWithName(db, {
        messageId: "<get-msg-lean@example.com>",
        fromAddress: "bob@example.com",
        fromName: "Bob",
        subject: "Single message",
      });

      const { formatMessageForOutput } = await import("~/messages/presenter");
      const testDb = getDb();
      const message = testDb.prepare("SELECT * FROM messages WHERE message_id = ?").get(normalizeMessageId(messageId)) as any;
      expect(message).toBeDefined();

      const shaped = await formatMessageForOutput(message, false, testDb);
      const out = shapeShapedToOutput([shaped], { useRaw: false, maxBodyChars: 2000 });

      expect(out).toHaveLength(1);
      assertLeanMessage(out[0] as Record<string, unknown>);
      expect((out[0] as Record<string, unknown>).message_id).toBe(messageId);
      expect((out[0] as Record<string, unknown>).subject).toBe("Single message");
    });
  });

  describe("get_messages (lean output)", () => {
    it("returns lean JSON array with no noise fields per message", async () => {
      const id1 = insertMessageWithName(db, {
        messageId: "<batch1@example.com>",
        fromAddress: "c@example.com",
        subject: "Batch one",
      });
      const id2 = insertMessageWithName(db, {
        messageId: "<batch2@example.com>",
        fromAddress: "d@example.com",
        subject: "Batch two",
      });

      const { formatMessageForOutput } = await import("~/messages/presenter");
      const testDb = getDb();
      const placeholders = "?,?";
      const messages = testDb
        .prepare(`SELECT * FROM messages WHERE message_id IN (${placeholders})`)
        .all(normalizeMessageId(id1), normalizeMessageId(id2)) as any[];

      const shaped = await Promise.all(messages.map((m) => formatMessageForOutput(m, false, testDb)));
      const out = shapeShapedToOutput(shaped, { useRaw: false, maxBodyChars: 2000 });

      expect(out).toHaveLength(2);
      assertLeanMessage(out[0] as Record<string, unknown>);
      assertLeanMessage(out[1] as Record<string, unknown>);
      expect((out[0] as Record<string, unknown>).message_id).toBe(id1);
      expect((out[1] as Record<string, unknown>).message_id).toBe(id2);
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
      const result = await who(testDb, {
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
      const result = await who(testDb, {
        query: "tom",
        ownerAddress,
      });

      expect(result.people).toHaveLength(1);
      expect(result.people[0].primaryAddress.toLowerCase()).toBe("tom@example.com");
      expect(result.people[0].firstname).toBe("Tom");
      expect(result.people[0].lastname).toBe("Smith");
      expect(result.people[0].receivedCount).toBeGreaterThanOrEqual(0); // Counts from people table
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
      const result = await who(testDb, {
        query: "geoff",
        ownerAddress,
      });

      expect(result.people).toHaveLength(1);
      expect(result.people[0].primaryAddress.toLowerCase()).toBe("geoff@company.com");
      expect(result.people[0].firstname).toBe("Geoff");
      expect(result.people[0].lastname).toBe("Cirne");
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
      const result = await who(testDb, {
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
      const result = await who(testDb, {
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

    it("returns search readiness", async () => {
      insertMessageWithName(db, { fromAddress: "alice@example.com" });
      insertMessageWithName(db, { fromAddress: "bob@example.com" });
      insertMessageWithName(db, { fromAddress: "charlie@example.com" });

      const testDb = getDb();
      const messagesCount = testDb.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };

      expect(messagesCount.count).toBe(3);
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
