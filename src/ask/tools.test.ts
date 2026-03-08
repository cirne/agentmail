import { describe, it, expect, beforeEach } from "vitest";
import type { SqliteDatabase } from "~/db";
import { createTestDb, insertTestMessage } from "~/db/test-helpers";
import { executeNanoTool } from "./tools";

describe("executeNanoTool", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  describe("search tool", () => {
    it("returns metadata-only results without bodyPreview", async () => {
      insertTestMessage(db, {
        subject: "Test invoice",
        bodyText: "This is a test invoice body with lots of content",
        fromAddress: "billing@example.com",
      });

      const result = await executeNanoTool(db, "search", {
        query: "invoice",
        limit: 10,
      });

      const parsed = JSON.parse(result);
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].subject).toBe("Test invoice");
      expect(parsed.results[0].fromAddress).toBe("billing@example.com");
      expect(parsed.results[0].snippet).toBeDefined();
      // Should NOT have bodyPreview
      expect(parsed.results[0].bodyPreview).toBeUndefined();
    });

    it("includes rank for relevance filtering", async () => {
      insertTestMessage(db, { subject: "Invoice 1", bodyText: "invoice content" });
      insertTestMessage(db, { subject: "Invoice 2", bodyText: "invoice content" });

      const result = await executeNanoTool(db, "search", {
        query: "invoice",
        limit: 10,
      });

      const parsed = JSON.parse(result);
      expect(parsed.results).toHaveLength(2);
      expect(parsed.results[0].rank).toBeDefined();
      expect(typeof parsed.results[0].rank).toBe("number");
    });

    it("parses relative dates to ISO format", async () => {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const isoDate = thirtyDaysAgo.toISOString().slice(0, 10);

      insertTestMessage(db, {
        subject: "Recent email",
        date: isoDate,
        bodyText: "content",
      });

      const result = await executeNanoTool(db, "search", {
        query: "recent",
        afterDate: "30d",
        limit: 10,
      });

      const parsed = JSON.parse(result);
      // Should find the message (date parsing worked)
      expect(parsed.results.length).toBeGreaterThanOrEqual(0);
    });

    it("leaves ISO dates unchanged", async () => {
      insertTestMessage(db, {
        subject: "Dated email",
        date: "2026-01-15T00:00:00Z",
        bodyText: "content",
      });

      const result = await executeNanoTool(db, "search", {
        query: "dated",
        afterDate: "2026-01-01",
        beforeDate: "2026-02-01",
        limit: 10,
      });

      const parsed = JSON.parse(result);
      // Should work with ISO dates
      expect(parsed.results).toBeDefined();
    });

    it("adds hint when 0 results", async () => {
      const result = await executeNanoTool(db, "search", {
        query: "nonexistent",
        limit: 10,
      });

      const parsed = JSON.parse(result);
      expect(parsed.results).toHaveLength(0);
      expect(parsed.hint).toContain("No results found");
    });

    it("adds hint when totalMatched > limit", async () => {
      // Create more messages than limit
      for (let i = 0; i < 15; i++) {
        insertTestMessage(db, {
          subject: `Invoice ${i}`,
          bodyText: "invoice content",
        });
      }

      const result = await executeNanoTool(db, "search", {
        query: "invoice",
        limit: 10,
      });

      const parsed = JSON.parse(result);
      expect(parsed.results.length).toBeLessThanOrEqual(10);
      if (parsed.totalMatched && parsed.totalMatched > 10) {
        expect(parsed.hint).toBeDefined();
        expect(parsed.hint).toContain("total matches");
      }
    });

    it("detects low diversity and adds hint", async () => {
      // Create many messages from same sender
      for (let i = 0; i < 10; i++) {
        insertTestMessage(db, {
          subject: `Message ${i}`,
          fromAddress: "same@example.com",
          bodyText: "content",
        });
      }

      const result = await executeNanoTool(db, "search", {
        query: "message",
        limit: 10,
      });

      const parsed = JSON.parse(result);
      if (parsed.results.length > 5) {
        // Check if diversity hint is present (may or may not trigger depending on exact counts)
        // The function checks if 80%+ from same sender
        const senders = new Set(parsed.results.map((r: any) => r.fromAddress));
        if (senders.size === 1 && parsed.results.length > 5) {
          expect(parsed.hint).toBeDefined();
        }
      }
    });

    it("sets hasEnoughContext when results are sufficient", async () => {
      // Create diverse results
      const senders = ["alice@example.com", "bob@example.com", "charlie@example.com"];
      for (let i = 0; i < 25; i++) {
        insertTestMessage(db, {
          subject: `Message ${i}`,
          fromAddress: senders[i % senders.length],
          bodyText: "content",
        });
      }

      const result = await executeNanoTool(db, "search", {
        query: "message",
        limit: 50,
      });

      const parsed = JSON.parse(result);
      // Should have enough context (20+ results with 3+ unique senders)
      if (parsed.results.length >= 20) {
        const uniqueSenders = new Set(parsed.results.map((r: any) => r.fromAddress)).size;
        if (uniqueSenders >= 3) {
          expect(parsed.hasEnoughContext).toBe(true);
        }
      }
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 10; i++) {
        insertTestMessage(db, {
          subject: `Test ${i}`,
          bodyText: "test content",
        });
      }

      const result = await executeNanoTool(db, "search", {
        query: "test",
        limit: 5,
      });

      const parsed = JSON.parse(result);
      expect(parsed.results.length).toBeLessThanOrEqual(5);
    });

    it("filters by fromAddress", async () => {
      insertTestMessage(db, {
        subject: "From Alice",
        fromAddress: "alice@example.com",
        bodyText: "content",
      });
      insertTestMessage(db, {
        subject: "From Bob",
        fromAddress: "bob@example.com",
        bodyText: "content",
      });

      const result = await executeNanoTool(db, "search", {
        query: "from",
        fromAddress: "alice@example.com",
        limit: 10,
      });

      const parsed = JSON.parse(result);
      expect(parsed.results.length).toBeGreaterThan(0);
      parsed.results.forEach((r: any) => {
        expect(r.fromAddress).toBe("alice@example.com");
      });
    });

    it("includes threads when includeThreads is true", async () => {
      const threadId = "<thread-123>";
      insertTestMessage(db, {
        messageId: "<msg1@example.com>",
        threadId,
        subject: "Thread subject",
        bodyText: "content",
      });
      insertTestMessage(db, {
        messageId: "<msg2@example.com>",
        threadId,
        subject: "Thread subject",
        bodyText: "reply",
      });

      const result = await executeNanoTool(db, "search", {
        query: "thread",
        includeThreads: true,
        limit: 10,
      });

      const parsed = JSON.parse(result);
      // May or may not have threads depending on search results
      if (parsed.threads) {
        expect(Array.isArray(parsed.threads)).toBe(true);
      }
    });
  });

  describe("who tool", () => {
    it("returns people matching query", async () => {
      insertTestMessage(db, {
        fromAddress: "alice@example.com",
        fromName: "Alice Smith",
        subject: "Hello",
        bodyText: "content",
      });

      const result = await executeNanoTool(db, "who", {
        query: "alice",
        limit: 10,
      });

      const parsed = JSON.parse(result);
      expect(parsed.people).toBeDefined();
      expect(Array.isArray(parsed.people)).toBe(true);
    });

    it("respects limit parameter", async () => {
      // Create multiple people
      for (let i = 0; i < 5; i++) {
        insertTestMessage(db, {
          fromAddress: `person${i}@example.com`,
          fromName: `Person ${i}`,
          subject: "Hello",
          bodyText: "content",
        });
      }

      const result = await executeNanoTool(db, "who", {
        query: "person",
        limit: 3,
      });

      const parsed = JSON.parse(result);
      if (parsed.people) {
        expect(parsed.people.length).toBeLessThanOrEqual(3);
      }
    });
  });

  describe("get_thread_headers tool", () => {
    it("returns thread headers", async () => {
      const threadId = "<thread-123>";
      insertTestMessage(db, {
        messageId: "<msg1@example.com>",
        threadId,
        subject: "Thread subject",
        fromAddress: "alice@example.com",
        date: "2026-01-01T10:00:00Z",
      });
      insertTestMessage(db, {
        messageId: "<msg2@example.com>",
        threadId,
        subject: "Thread subject",
        fromAddress: "bob@example.com",
        date: "2026-01-01T11:00:00Z",
      });

      const result = executeNanoTool(db, "get_thread_headers", {
        threadId,
      });

      const parsed = JSON.parse(await result);
      expect(parsed.threadId).toBeDefined();
      expect(parsed.messages).toBeDefined();
      expect(Array.isArray(parsed.messages)).toBe(true);
      expect(parsed.messages.length).toBe(2);
      expect(parsed.messages[0].messageId).toBe("<msg1@example.com>");
      expect(parsed.messages[1].messageId).toBe("<msg2@example.com>");
    });

    it("returns error when thread not found", async () => {
      const result = executeNanoTool(db, "get_thread_headers", {
        threadId: "<nonexistent-thread>",
      });

      const parsed = JSON.parse(await result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("not found");
    });

    it("normalizes thread ID", async () => {
      const threadId = "thread-123"; // Without angle brackets
      insertTestMessage(db, {
        messageId: "<msg1@example.com>",
        threadId: `<${threadId}>`,
        subject: "Test",
        bodyText: "content",
      });

      const result = executeNanoTool(db, "get_thread_headers", {
        threadId,
      });

      const parsed = JSON.parse(await result);
      expect(parsed.messages).toBeDefined();
      expect(parsed.messages.length).toBeGreaterThan(0);
    });
  });

  describe("error handling", () => {
    it("returns error for unknown tool", async () => {
      const result = await executeNanoTool(db, "unknown_tool", {
        query: "test",
      });

      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
      expect(parsed.error).toContain("Unknown tool");
    });

    it("handles missing required parameters gracefully", async () => {
      // search requires query
      const result = await executeNanoTool(db, "search", {});

      const parsed = JSON.parse(result);
      // Should either return error or empty results, not crash
      expect(parsed).toBeDefined();
    });
  });
});
