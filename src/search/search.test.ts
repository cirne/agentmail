import { describe, it, expect, beforeEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb, insertTestMessage } from "~/db/test-helpers";
import { search, searchWithMeta } from "./index";

describe("search", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns empty array when no messages exist", async () => {
    const results = await search(db, { query: "anything" });
    expect(results).toEqual([]);
  });

  it("finds a message by subject keyword", async () => {
    insertTestMessage(db, { subject: "Invoice from Stripe" });
    const results = await search(db, { query: "Invoice" });
    expect(results.length).toBe(1);
    expect(results[0].subject).toBe("Invoice from Stripe");
  });

  it("finds a message by body keyword", async () => {
    insertTestMessage(db, {
      subject: "Meeting notes",
      bodyText: "We discussed the Q4 roadmap and budget allocation",
    });
    const results = await search(db, { query: "roadmap" });
    expect(results.length).toBe(1);
  });

  it("returns multiple matches ranked by relevance", async () => {
    insertTestMessage(db, {
      subject: "Contract renewal",
      bodyText: "Please review the attached contract for renewal",
    });
    insertTestMessage(db, {
      subject: "Quick question",
      bodyText: "Can you check the contract?",
    });
    insertTestMessage(db, {
      subject: "Unrelated email",
      bodyText: "Lunch plans for tomorrow",
    });

    const results = await search(db, { query: "contract" });
    expect(results.length).toBe(2);
  });

  it("respects the limit option", async () => {
    for (let i = 0; i < 5; i++) {
      insertTestMessage(db, { subject: `Report number ${i}`, bodyText: "report content" });
    }
    const results = await search(db, { query: "report", limit: 3 });
    expect(results.length).toBe(3);
  });

  it("returns expected fields on each result", async () => {
    insertTestMessage(db, {
      subject: "Hello from Alice",
      fromAddress: "alice@example.com",
      bodyText: "Just checking in",
    });

    const results = await search(db, { query: "Hello" });
    expect(results.length).toBe(1);

    const r = results[0];
    expect(r.messageId).toBeDefined();
    expect(r.threadId).toBeDefined();
    expect(r.subject).toBe("Hello from Alice");
    expect(r.fromAddress).toBe("alice@example.com");
    expect(r.date).toBeDefined();
    expect(r.snippet).toBeDefined();
    expect(r.rank).toBeDefined();
  });

  it("does not return messages that do not match", async () => {
    insertTestMessage(db, { subject: "Cats are great", bodyText: "I love cats" });
    const results = await search(db, { query: "dogs" });
    expect(results.length).toBe(0);
  });

  it("handles FTS special characters without throwing", async () => {
    insertTestMessage(db, { subject: "Normal email" });
    expect(async () => await search(db, { query: "hello world" })).not.toThrow();
  });

  it("filters by fromAddress", async () => {
    insertTestMessage(db, {
      subject: "Message from Alice",
      fromAddress: "alice@example.com",
      bodyText: "Hello",
    });
    insertTestMessage(db, {
      subject: "Message from Bob",
      fromAddress: "bob@example.com",
      bodyText: "Hello",
    });

    const results = await search(db, { query: "Hello", fromAddress: "alice@example.com" });
    expect(results.length).toBe(1);
    expect(results[0].fromAddress).toBe("alice@example.com");
  });

  it("filters by afterDate", async () => {
    insertTestMessage(db, {
      subject: "Old message",
      date: "2024-01-01T00:00:00Z",
      bodyText: "test",
    });
    insertTestMessage(db, {
      subject: "Recent message",
      date: "2024-12-01T00:00:00Z",
      bodyText: "test",
    });

    const results = await search(db, { query: "test", afterDate: "2024-06-01" });
    expect(results.length).toBe(1);
    expect(results[0].subject).toBe("Recent message");
  });

  it("filters by beforeDate", async () => {
    insertTestMessage(db, {
      subject: "Old message",
      date: "2024-01-01T00:00:00Z",
      bodyText: "test",
    });
    insertTestMessage(db, {
      subject: "Recent message",
      date: "2024-12-01T00:00:00Z",
      bodyText: "test",
    });

    const results = await search(db, { query: "test", beforeDate: "2024-06-01" });
    expect(results.length).toBe(1);
    expect(results[0].subject).toBe("Old message");
  });

  it("combines multiple filters", async () => {
    insertTestMessage(db, {
      subject: "Match 1",
      fromAddress: "alice@example.com",
      date: "2024-06-15T00:00:00Z",
      bodyText: "contract discussion",
    });
    insertTestMessage(db, {
      subject: "Match 2",
      fromAddress: "alice@example.com",
      date: "2024-01-15T00:00:00Z",
      bodyText: "contract discussion",
    });
    insertTestMessage(db, {
      subject: "No match",
      fromAddress: "bob@example.com",
      date: "2024-06-15T00:00:00Z",
      bodyText: "contract discussion",
    });

    const results = await search(db, {
      query: "contract",
      fromAddress: "alice@example.com",
      afterDate: "2024-06-01",
    });
    expect(results.length).toBe(1);
    expect(results[0].subject).toBe("Match 1");
  });

  it("filter-only search returns results sorted by date", async () => {
    insertTestMessage(db, {
      subject: "Older",
      fromAddress: "alice@example.com",
      date: "2024-01-01T00:00:00Z",
    });
    insertTestMessage(db, {
      subject: "Newer",
      fromAddress: "alice@example.com",
      date: "2024-12-01T00:00:00Z",
    });

    const results = await search(db, { fromAddress: "alice" });
    expect(results.length).toBe(2);
    expect(results[0].subject).toBe("Newer");
  });

  it("auto mode resolves to fts for lexical queries", async () => {
    insertTestMessage(db, { subject: "Invoice from Stripe" });
    const run = await searchWithMeta(db, { query: "Invoice", mode: "auto" });
    expect(run.timings.modeUsed).toBe("fts");
    expect(run.timings.ftsMs).toBeDefined();
    expect(run.results.length).toBe(1);
  });

  it("filter-only path reports filter mode", async () => {
    insertTestMessage(db, { fromAddress: "alice@example.com", subject: "Hello" });
    const run = await searchWithMeta(db, { fromAddress: "alice" });
    expect(run.timings.modeUsed).toBe("filter");
    expect(run.results.length).toBe(1);
  });
});
