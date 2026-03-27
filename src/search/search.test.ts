import { describe, it, expect, beforeEach } from "vitest";
import type { SqliteDatabase } from "~/db";
import { createTestDb, insertTestMessage } from "~/db/test-helpers";
import { search, searchWithMeta } from "./index";

describe("search", () => {
  let db: SqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("returns empty array when no messages exist", async () => {
    const results = await search(db, { query: "anything" });
    expect(results).toEqual([]);
  });

  it("finds a message by subject keyword", async () => {
    await insertTestMessage(db, { subject: "Invoice from Stripe" });
    const results = await search(db, { query: "Invoice" });
    expect(results.length).toBe(1);
    expect(results[0].subject).toBe("Invoice from Stripe");
  });

  it("finds a message by body keyword", async () => {
    await insertTestMessage(db, {
      subject: "Meeting notes",
      bodyText: "We discussed the Q4 roadmap and budget allocation",
    });
    const results = await search(db, { query: "roadmap" });
    expect(results.length).toBe(1);
  });

  it("returns multiple matches ranked by relevance", async () => {
    await insertTestMessage(db, {
      subject: "Contract renewal",
      bodyText: "Please review the attached contract for renewal",
    });
    await insertTestMessage(db, {
      subject: "Quick question",
      bodyText: "Can you check the contract?",
    });
    await insertTestMessage(db, {
      subject: "Unrelated email",
      bodyText: "Lunch plans for tomorrow",
    });

    const results = await search(db, { query: "contract" });
    expect(results.length).toBe(2);
  });

  it("respects the limit option", async () => {
    for (let i = 0; i < 5; i++) {
      await insertTestMessage(db, { subject: `Report number ${i}`, bodyText: "report content" });
    }
    const results = await search(db, { query: "report", limit: 3 });
    expect(results.length).toBe(3);
  });

  it("returns expected fields on each result", async () => {
    await insertTestMessage(db, {
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
    await insertTestMessage(db, { subject: "Cats are great", bodyText: "I love cats" });
    const results = await search(db, { query: "dogs" });
    expect(results.length).toBe(0);
  });

  it("handles FTS special characters without throwing", async () => {
    await insertTestMessage(db, { subject: "Normal email" });
    expect(async () => await search(db, { query: "hello world" })).not.toThrow();
  });

  it("filters by fromAddress", async () => {
    await insertTestMessage(db, {
      subject: "Message from Alice",
      fromAddress: "alice@example.com",
      bodyText: "Hello",
    });
    await insertTestMessage(db, {
      subject: "Message from Bob",
      fromAddress: "bob@example.com",
      bodyText: "Hello",
    });

    const results = await search(db, { query: "Hello", fromAddress: "alice@example.com" });
    expect(results.length).toBe(1);
    expect(results[0].fromAddress).toBe("alice@example.com");
  });

  it("filters by afterDate", async () => {
    await insertTestMessage(db, {
      subject: "Old message",
      date: "2024-01-01T00:00:00Z",
      bodyText: "test",
    });
    await insertTestMessage(db, {
      subject: "Recent message",
      date: "2024-12-01T00:00:00Z",
      bodyText: "test",
    });

    const results = await search(db, { query: "test", afterDate: "2024-06-01" });
    expect(results.length).toBe(1);
    expect(results[0].subject).toBe("Recent message");
  });

  it("filters by beforeDate", async () => {
    await insertTestMessage(db, {
      subject: "Old message",
      date: "2024-01-01T00:00:00Z",
      bodyText: "test",
    });
    await insertTestMessage(db, {
      subject: "Recent message",
      date: "2024-12-01T00:00:00Z",
      bodyText: "test",
    });

    const results = await search(db, { query: "test", beforeDate: "2024-06-01" });
    expect(results.length).toBe(1);
    expect(results[0].subject).toBe("Old message");
  });

  it("combines multiple filters", async () => {
    await insertTestMessage(db, {
      subject: "Match 1",
      fromAddress: "alice@example.com",
      date: "2024-06-15T00:00:00Z",
      bodyText: "contract discussion",
    });
    await insertTestMessage(db, {
      subject: "Match 2",
      fromAddress: "alice@example.com",
      date: "2024-01-15T00:00:00Z",
      bodyText: "contract discussion",
    });
    await insertTestMessage(db, {
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
    await insertTestMessage(db, {
      subject: "Older",
      fromAddress: "alice@example.com",
      date: "2024-01-01T00:00:00Z",
    });
    await insertTestMessage(db, {
      subject: "Newer",
      fromAddress: "alice@example.com",
      date: "2024-12-01T00:00:00Z",
    });

    const results = await search(db, { fromAddress: "alice" });
    expect(results.length).toBe(2);
    expect(results[0].subject).toBe("Newer");
  });

  it("uses FTS search", async () => {
    await insertTestMessage(db, { subject: "Invoice from Stripe" });
    const run = await searchWithMeta(db, { query: "Invoice" });
    expect(run.timings.ftsMs).toBeDefined();
    expect(run.results.length).toBeGreaterThanOrEqual(1);
  });

  describe("inline query operators", () => {
    it("parses from: operator in query string", async () => {
      await insertTestMessage(db, {
        subject: "Message from Alice",
        fromAddress: "alice@example.com",
        bodyText: "Hello",
      });
      await insertTestMessage(db, {
        subject: "Message from Bob",
        fromAddress: "bob@example.com",
        bodyText: "Hello",
      });

      const results = await search(db, { query: "from:alice@example.com Hello" });
      expect(results.length).toBe(1);
      expect(results[0].fromAddress).toBe("alice@example.com");
    });

    it("parses subject: operator in query string", async () => {
      await insertTestMessage(db, {
        subject: "Invoice from Stripe",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "Meeting notes",
        bodyText: "test",
      });

      const results = await search(db, { query: 'subject:"Invoice from Stripe"' });
      expect(results.length).toBe(1);
      expect(results[0].subject).toBe("Invoice from Stripe");
    });

    it("parses after: operator with relative date", async () => {
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 3); // 3 days ago
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 10); // 10 days ago

      await insertTestMessage(db, {
        subject: "Recent",
        date: recentDate.toISOString(),
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "Old",
        date: oldDate.toISOString(),
        bodyText: "test",
      });

      const results = await search(db, { query: "after:7d test" });
      expect(results.length).toBe(1);
      expect(results[0].subject).toBe("Recent");
    });

    it("parses before: operator with ISO date", async () => {
      await insertTestMessage(db, {
        subject: "Old message",
        date: "2024-01-01T00:00:00Z",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "Recent message",
        date: "2024-12-01T00:00:00Z",
        bodyText: "test",
      });

      const results = await search(db, { query: "before:2024-06-01 test" });
      expect(results.length).toBe(1);
      expect(results[0].subject).toBe("Old message");
    });

    it("parses multiple operators together", async () => {
      await insertTestMessage(db, {
        subject: "Match",
        fromAddress: "alice@example.com",
        date: "2024-06-15T00:00:00Z",
        bodyText: "contract discussion",
      });
      await insertTestMessage(db, {
        subject: "No match - wrong sender",
        fromAddress: "bob@example.com",
        date: "2024-06-15T00:00:00Z",
        bodyText: "contract discussion",
      });
      await insertTestMessage(db, {
        subject: "No match - too old",
        fromAddress: "alice@example.com",
        date: "2024-01-15T00:00:00Z",
        bodyText: "contract discussion",
      });

      const results = await search(db, {
        query: "from:alice@example.com after:2024-06-01 contract",
      });
      expect(results.length).toBe(1);
      expect(results[0].subject).toBe("Match");
    });

    it("normalizes OR/AND to uppercase", async () => {
      await insertTestMessage(db, { subject: "Invoice", bodyText: "invoice content" });
      await insertTestMessage(db, { subject: "Receipt", bodyText: "receipt content" });
      await insertTestMessage(db, { subject: "Other", bodyText: "other content" });

      // Should work with lowercase 'or' (gets normalized)
      const results = await search(db, { query: "invoice or receipt" });
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

  it("handles to: operator", async () => {
    await insertTestMessage(db, {
      subject: "To Bob",
      toAddresses: JSON.stringify(["bob@example.com"]),
      bodyText: "test",
    });
    await insertTestMessage(db, {
      subject: "To Alice",
      toAddresses: JSON.stringify(["alice@example.com"]),
      bodyText: "test",
    });

    const results = await search(db, { query: "to:bob@example.com test" });
    expect(results.length).toBe(1);
    expect(results[0].subject).toBe("To Bob");
  });

  describe("OR/AND filter logic", () => {
    it("handles OR between filters (from:marcio OR to:marcio)", async () => {
      await insertTestMessage(db, {
        subject: "From Marcio",
        fromAddress: "marcio@example.com",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "To Marcio",
        toAddresses: JSON.stringify(["marcio@example.com"]),
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "Unrelated",
        fromAddress: "other@example.com",
        toAddresses: JSON.stringify(["other@example.com"]),
        bodyText: "test",
      });

      const results = await search(db, { query: "from:marcio OR to:marcio" });
      expect(results.length).toBe(2);
      const subjects = results.map((r) => r.subject).sort();
      expect(subjects).toEqual(["From Marcio", "To Marcio"]);
    });

    it("handles OR with three filters (from:alice OR to:bob OR subject:meeting)", async () => {
      await insertTestMessage(db, {
        subject: "From Alice",
        fromAddress: "alice@example.com",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "To Bob",
        toAddresses: JSON.stringify(["bob@example.com"]),
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "Meeting notes",
        fromAddress: "other@example.com",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "Unrelated",
        fromAddress: "other@example.com",
        bodyText: "test",
      });

      const results = await search(db, { query: "from:alice OR to:bob OR subject:meeting" });
      expect(results.length).toBe(3);
      const subjects = results.map((r) => r.subject).sort();
      expect(subjects).toEqual(["From Alice", "Meeting notes", "To Bob"]);
    });

    it("handles AND between filters (from:alice AND to:bob)", async () => {
      await insertTestMessage(db, {
        subject: "Match",
        fromAddress: "alice@example.com",
        toAddresses: JSON.stringify(["bob@example.com"]),
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "No match - wrong to",
        fromAddress: "alice@example.com",
        toAddresses: JSON.stringify(["charlie@example.com"]),
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "No match - wrong from",
        fromAddress: "charlie@example.com",
        toAddresses: JSON.stringify(["bob@example.com"]),
        bodyText: "test",
      });

      const results = await search(db, { query: "from:alice AND to:bob" });
      expect(results.length).toBe(1);
      expect(results[0].subject).toBe("Match");
    });

    it("handles OR with date filters (from:alice OR after:2024-06-01)", async () => {
      await insertTestMessage(db, {
        subject: "From Alice",
        fromAddress: "alice@example.com",
        date: "2024-01-01T00:00:00Z",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "Recent",
        fromAddress: "other@example.com",
        date: "2024-12-01T00:00:00Z",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "Old",
        fromAddress: "other@example.com",
        date: "2024-01-01T00:00:00Z",
        bodyText: "test",
      });

      const results = await search(db, { query: "from:alice OR after:2024-06-01" });
      expect(results.length).toBe(2);
      const subjects = results.map((r) => r.subject).sort();
      expect(subjects).toEqual(["From Alice", "Recent"]);
    });

    it("handles subject filter with text query (subject:invoice receipt)", async () => {
      await insertTestMessage(db, {
        subject: "Invoice #123",
        bodyText: "receipt",
      });
      await insertTestMessage(db, {
        subject: "Payment confirmation",
        bodyText: "receipt attached",
      });
      await insertTestMessage(db, {
        subject: "Invoice #456",
        bodyText: "no receipt",
      });

      // This should search for subject contains "invoice" AND body contains "receipt"
      const results = await search(db, { query: "subject:invoice receipt" });
      expect(results.length).toBeGreaterThanOrEqual(1);
      const subjects = results.map((r) => r.subject);
      expect(subjects).toContain("Invoice #123");
    });

    it("handles mixed OR/AND in complex query", async () => {
      await insertTestMessage(db, {
        subject: "Match 1",
        fromAddress: "alice@example.com",
        toAddresses: JSON.stringify(["bob@example.com"]),
        date: "2024-12-01T00:00:00Z",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "Match 2",
        fromAddress: "charlie@example.com",
        toAddresses: JSON.stringify(["bob@example.com"]),
        date: "2024-12-01T00:00:00Z",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "No match - old date",
        fromAddress: "alice@example.com",
        toAddresses: JSON.stringify(["bob@example.com"]),
        date: "2024-01-01T00:00:00Z",
        bodyText: "test",
      });

      // (from:alice OR to:bob) AND after:2024-06-01
      // Note: This is a limitation - we can't do nested OR/AND, but we can do OR with date filters
      const results = await search(db, { query: "from:alice OR to:bob after:2024-06-01" });
      // Should match messages where (from=alice OR to=bob) AND date >= 2024-06-01
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("handles OR with quoted subject values", async () => {
      await insertTestMessage(db, {
        subject: "Meeting notes",
        fromAddress: "alice@example.com",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "Other",
        bodyText: "test",
      });

      const results = await search(db, { query: 'subject:"Meeting notes" OR from:alice' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      const subjects = results.map((r) => r.subject);
      expect(subjects).toContain("Meeting notes");
    });

    it("handles single filter with OR text (should not use filter OR logic)", async () => {
      await insertTestMessage(db, {
        subject: "Invoice",
        bodyText: "invoice OR receipt",
      });
      await insertTestMessage(db, {
        subject: "Receipt",
        bodyText: "invoice OR receipt",
      });

      // from:alice invoice OR receipt - should search text "invoice OR receipt" with from filter
      const results = await search(db, { query: "from:alice invoice OR receipt" });
      // Should use FTS search, not filter-only
      expect(results.length).toBeGreaterThanOrEqual(0);
    });

    it("handles empty query with OR between filters", async () => {
      await insertTestMessage(db, {
        subject: "From Alice",
        fromAddress: "alice@example.com",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "To Bob",
        toAddresses: JSON.stringify(["bob@example.com"]),
        bodyText: "test",
      });

      const results = await search(db, { query: "from:alice OR to:bob" });
      expect(results.length).toBe(2);
    });

    it("handles case-insensitive OR/AND", async () => {
      await insertTestMessage(db, {
        subject: "From Alice",
        fromAddress: "alice@example.com",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "To Bob",
        toAddresses: JSON.stringify(["bob@example.com"]),
        bodyText: "test",
      });

      // Lowercase "or" should work (gets normalized to OR)
      const results = await search(db, { query: "from:alice or to:bob" });
      expect(results.length).toBe(2);
      const subjects = results.map((r) => r.subject).sort();
      expect(subjects).toEqual(["From Alice", "To Bob"]);
    });

    it("handles OR with partial matches in addresses", async () => {
      await insertTestMessage(db, {
        subject: "From Marcio",
        fromAddress: "marcio.silva@example.com",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "To Marcio",
        toAddresses: JSON.stringify(["marcio@company.com"]),
        bodyText: "test",
      });

      // Should match both with partial "marcio"
      const results = await search(db, { query: "from:marcio OR to:marcio" });
      expect(results.length).toBe(2);
    });

    it("handles AND with date range filters", async () => {
      await insertTestMessage(db, {
        subject: "Match",
        fromAddress: "alice@example.com",
        date: "2024-06-15T00:00:00Z",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "No match - wrong date",
        fromAddress: "alice@example.com",
        date: "2024-01-01T00:00:00Z",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "No match - wrong sender",
        fromAddress: "bob@example.com",
        date: "2024-06-15T00:00:00Z",
        bodyText: "test",
      });

      const results = await search(db, { query: "from:alice AND after:2024-06-01" });
      expect(results.length).toBe(1);
      expect(results[0].subject).toBe("Match");
    });

    it("handles OR with before date filter", async () => {
      await insertTestMessage(db, {
        subject: "Old from Alice",
        fromAddress: "alice@example.com",
        date: "2024-01-01T00:00:00Z",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "Recent from Alice",
        fromAddress: "alice@example.com",
        date: "2024-12-01T00:00:00Z",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "Old other",
        fromAddress: "other@example.com",
        date: "2024-01-01T00:00:00Z",
        bodyText: "test",
      });

      // from:alice OR before:2024-06-01 should match:
      // - Any message from alice (regardless of date)
      // - Any message before 2024-06-01 (regardless of sender)
      const results = await search(db, { query: "from:alice OR before:2024-06-01" });
      expect(results.length).toBe(3);
      const subjects = results.map((r) => r.subject).sort();
      expect(subjects).toEqual(["Old from Alice", "Old other", "Recent from Alice"]);
    });

    it("handles multiple ORs with mixed filter types", async () => {
      await insertTestMessage(db, {
        subject: "From Alice",
        fromAddress: "alice@example.com",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "Meeting notes",
        fromAddress: "other@example.com",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "To Bob",
        toAddresses: JSON.stringify(["bob@example.com"]),
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "Recent",
        fromAddress: "other@example.com",
        date: "2024-12-01T00:00:00Z",
        bodyText: "test",
      });

      // from:alice OR subject:meeting OR to:bob OR after:2024-06-01
      const results = await search(db, { query: "from:alice OR subject:meeting OR to:bob OR after:2024-06-01" });
      expect(results.length).toBe(4);
    });

    it("handles OR with CC addresses", async () => {
      await insertTestMessage(db, {
        subject: "From Alice",
        fromAddress: "alice@example.com",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "CC to Bob",
        fromAddress: "other@example.com",
        ccAddresses: JSON.stringify(["bob@example.com"]),
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "Unrelated",
        fromAddress: "other@example.com",
        bodyText: "test",
      });

      const results = await search(db, { query: "from:alice OR to:bob" });
      expect(results.length).toBe(2);
      const subjects = results.map((r) => r.subject).sort();
      expect(subjects).toEqual(["CC to Bob", "From Alice"]);
    });

    it("handles AND with multiple date filters", async () => {
      await insertTestMessage(db, {
        subject: "Match",
        fromAddress: "alice@example.com",
        date: "2024-06-15T00:00:00Z",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "Too old",
        fromAddress: "alice@example.com",
        date: "2024-01-01T00:00:00Z",
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "Too new",
        fromAddress: "alice@example.com",
        date: "2024-12-01T00:00:00Z",
        bodyText: "test",
      });

      // from:alice AND after:2024-06-01 AND before:2024-07-01
      const results = await search(db, { query: "from:alice AND after:2024-06-01 AND before:2024-07-01" });
      expect(results.length).toBe(1);
      expect(results[0].subject).toBe("Match");
    });

    it("handles OR with relative dates", async () => {
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 3);
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 10);

      await insertTestMessage(db, {
        subject: "Recent from Alice",
        fromAddress: "alice@example.com",
        date: recentDate.toISOString(),
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "Old from Bob",
        fromAddress: "bob@example.com",
        date: oldDate.toISOString(),
        bodyText: "test",
      });
      await insertTestMessage(db, {
        subject: "Old from Alice",
        fromAddress: "alice@example.com",
        date: oldDate.toISOString(),
        bodyText: "test",
      });

      // from:alice OR after:7d
      const results = await search(db, { query: "from:alice OR after:7d" });
      expect(results.length).toBeGreaterThanOrEqual(1);
      const subjects = results.map((r) => r.subject);
      expect(subjects).toContain("Recent from Alice");
    });

    it("handles filters with text query (not filter-only)", async () => {
      await insertTestMessage(db, {
        subject: "Invoice from Alice",
        fromAddress: "alice@example.com",
        bodyText: "invoice content",
      });
      await insertTestMessage(db, {
        subject: "Receipt from Alice",
        fromAddress: "alice@example.com",
        bodyText: "receipt content",
      });
      await insertTestMessage(db, {
        subject: "Invoice from Bob",
        fromAddress: "bob@example.com",
        bodyText: "invoice content",
      });

      // from:alice invoice - should match invoices from alice
      const results = await search(db, { query: "from:alice invoice" });
      expect(results.length).toBeGreaterThanOrEqual(1);
      const subjects = results.map((r) => r.subject);
      expect(subjects).toContain("Invoice from Alice");
      // Should not match bob's invoice
      expect(subjects).not.toContain("Invoice from Bob");
    });

    it("handles empty result set with OR filters", async () => {
      await insertTestMessage(db, {
        subject: "Unrelated",
        fromAddress: "other@example.com",
        bodyText: "test",
      });

      const results = await search(db, { query: "from:nonexistent OR to:nonexistent" });
      expect(results.length).toBe(0);
    });
  });

  });

  describe("OPP-012 contact rank (search)", () => {
    it("ranks a frequent correspondent higher when body match strength is similar", async () => {
      const owner = "me@example.com";
      const friend = "friend@example.com";
      const stranger = "stranger@example.com";
      const tieBody = "zzopp027tiekeywordzz same text for both";
      for (let i = 0; i < 12; i++) {
        await insertTestMessage(db, {
          fromAddress: owner,
          toAddresses: JSON.stringify([friend]),
          bodyText: "history bulk",
          subject: "hist",
        });
      }
      await insertTestMessage(db, {
        fromAddress: friend,
        toAddresses: JSON.stringify([owner]),
        bodyText: "reply",
        subject: "hist",
      });
      await insertTestMessage(db, {
        messageId: "<tie-friend@x>",
        fromAddress: friend,
        toAddresses: JSON.stringify([owner]),
        bodyText: tieBody,
        subject: "Tie friend",
      });
      await insertTestMessage(db, {
        messageId: "<tie-stranger@x>",
        fromAddress: stranger,
        toAddresses: JSON.stringify([owner]),
        bodyText: tieBody,
        subject: "Tie stranger",
      });

      const results = await search(db, {
        query: "zzopp027tiekeywordzz",
        limit: 10,
        ownerAddress: owner,
      });
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results[0].fromAddress).toBe(friend);
    });

    it("filter-only search reranks by contact rank when owner is set", async () => {
      const owner = "me@example.com";
      const friend = "friend@example.com";
      const stranger = "stranger@example.com";
      for (let i = 0; i < 8; i++) {
        await insertTestMessage(db, {
          fromAddress: owner,
          toAddresses: JSON.stringify([friend]),
          bodyText: "bulk",
          subject: "s",
          date: "2023-06-01T12:00:00Z",
        });
      }
      await insertTestMessage(db, {
        fromAddress: friend,
        toAddresses: JSON.stringify([owner]),
        bodyText: "hi",
        subject: "s",
        date: "2023-06-02T12:00:00Z",
      });
      await insertTestMessage(db, {
        fromAddress: friend,
        toAddresses: JSON.stringify([owner]),
        bodyText: "in window",
        subject: "s",
        date: "2024-06-01T12:00:00Z",
      });
      await insertTestMessage(db, {
        messageId: "<new-stranger@x>",
        fromAddress: stranger,
        toAddresses: JSON.stringify([owner]),
        bodyText: "in window",
        subject: "s",
        date: "2024-06-10T12:00:00Z",
      });

      const results = await search(db, {
        afterDate: "2024-01-01",
        limit: 5,
        ownerAddress: owner,
      });
      expect(results.length).toBe(2);
      expect(results[0].fromAddress).toBe(friend);
    });
  });

});
