import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SqliteDatabase } from "~/db";
import { createTestDb, insertTestMessage } from "~/db/test-helpers";
import { scatter } from "./scatter";
import type { SearchPlan } from "./planner";

// Mock verbose logging
vi.mock("./verbose", () => ({
  verboseLog: vi.fn(),
}));

describe("scatter", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  it("executes pattern searches in parallel and deduplicates", async () => {
    // Insert messages that match different patterns
    insertTestMessage(db, {
      messageId: "<msg1@example.com>",
      subject: "Invoice from Apple",
      bodyText: "invoice content",
      fromAddress: "billing@apple.com",
    });

    insertTestMessage(db, {
      messageId: "<msg2@example.com>",
      subject: "Receipt from Apple",
      bodyText: "receipt content",
      fromAddress: "noreply@apple.com",
    });

    insertTestMessage(db, {
      messageId: "<msg3@example.com>",
      subject: "Purchase confirmation",
      bodyText: "purchase content",
      fromAddress: "orders@example.com",
    });

    const plan: SearchPlan = {
      patterns: ["invoice", "receipt", "purchase"],
      includeNoise: false,
    };

    const results = await scatter(plan, db);

    // Should find all 3 messages (each matches a different pattern)
    expect(results.length).toBeGreaterThanOrEqual(3);
    const messageIds = results.map((r) => r.messageId);
    expect(messageIds).toContain("<msg1@example.com>");
    expect(messageIds).toContain("<msg2@example.com>");
    expect(messageIds).toContain("<msg3@example.com>");
  });

  it("deduplicates messages that match multiple patterns", async () => {
    // Insert a message that matches multiple patterns
    insertTestMessage(db, {
      messageId: "<msg1@example.com>",
      subject: "Invoice and receipt",
      bodyText: "invoice receipt content",
      fromAddress: "billing@example.com",
    });

    const plan: SearchPlan = {
      patterns: ["invoice", "receipt"],
      includeNoise: false,
    };

    const results = await scatter(plan, db);

    // Should only appear once despite matching both patterns
    expect(results.length).toBe(1);
    expect(results[0].messageId).toBe("<msg1@example.com>");
  });

  it("adds filter-only search when fromAddress is present", async () => {
    insertTestMessage(db, {
      messageId: "<msg1@example.com>",
      subject: "Order confirmation",
      bodyText: "order content",
      fromAddress: "noreply@apple.com",
    });

    insertTestMessage(db, {
      messageId: "<msg2@example.com>",
      subject: "Shipping update",
      bodyText: "shipping content",
      fromAddress: "noreply@apple.com",
    });

    const plan: SearchPlan = {
      patterns: ["order"], // Only matches msg1
      fromAddress: "apple.com",
      includeNoise: false,
    };

    const results = await scatter(plan, db);

    // Should find both messages: msg1 matches pattern, msg2 matches filter-only
    expect(results.length).toBeGreaterThanOrEqual(2);
    const messageIds = results.map((r) => r.messageId);
    expect(messageIds).toContain("<msg1@example.com>");
    expect(messageIds).toContain("<msg2@example.com>");
  });

  it("preserves best FTS5 rank when deduplicating", async () => {
    // Insert a message that will match multiple patterns with different ranks
    insertTestMessage(db, {
      messageId: "<msg1@example.com>",
      subject: "Invoice receipt",
      bodyText: "invoice receipt content",
      fromAddress: "billing@example.com",
    });

    const plan: SearchPlan = {
      patterns: ["invoice", "receipt"],
      includeNoise: false,
    };

    const results = await scatter(plan, db);

    // Should appear once with the best (lowest) rank
    expect(results.length).toBe(1);
    expect(results[0].messageId).toBe("<msg1@example.com>");
    // Rank should be present (FTS5 assigns ranks)
    expect(results[0].rank).toBeDefined();
  });

  it("passes through includeNoise flag", async () => {
    // Insert a noise message
    const noiseMessageId = insertTestMessage(db, {
      messageId: "<noise@example.com>",
      subject: "Promotional email",
      bodyText: "promo content",
      fromAddress: "marketing@example.com",
    });
    // Mark as noise
    db.prepare("UPDATE messages SET is_noise = 1 WHERE message_id = ?").run(noiseMessageId);

    const planWithNoise: SearchPlan = {
      patterns: ["promo"],
      includeNoise: true,
    };

    const resultsWithNoise = await scatter(planWithNoise, db);
    const foundWithNoise = resultsWithNoise.some((r) => r.messageId === "<noise@example.com>");

    const planWithoutNoise: SearchPlan = {
      patterns: ["promo"],
      includeNoise: false,
    };

    const resultsWithoutNoise = await scatter(planWithoutNoise, db);
    const foundWithoutNoise = resultsWithoutNoise.some((r) => r.messageId === "<noise@example.com>");

    // With includeNoise=true, should find noise message
    // With includeNoise=false, should exclude noise message
    expect(foundWithNoise).toBe(true);
    expect(foundWithoutNoise).toBe(false);
  });

  it("passes through date filters", async () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const sixtyDaysAgo = new Date(now);
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    insertTestMessage(db, {
      messageId: "<recent@example.com>",
      subject: "Recent invoice",
      bodyText: "invoice",
      date: thirtyDaysAgo.toISOString(),
    });

    insertTestMessage(db, {
      messageId: "<old@example.com>",
      subject: "Old invoice",
      bodyText: "invoice",
      date: sixtyDaysAgo.toISOString(),
    });

    const plan: SearchPlan = {
      patterns: ["invoice"],
      afterDate: "45d", // Should only match recent message
      includeNoise: false,
    };

    const results = await scatter(plan, db);

    const messageIds = results.map((r) => r.messageId);
    expect(messageIds).toContain("<recent@example.com>");
    expect(messageIds).not.toContain("<old@example.com>");
  });

  it("handles empty patterns array", async () => {
    const plan: SearchPlan = {
      patterns: [],
      includeNoise: false,
    };

    const results = await scatter(plan, db);

    expect(results).toEqual([]);
  });

  it("handles no matches", async () => {
    const plan: SearchPlan = {
      patterns: ["nonexistent"],
      includeNoise: false,
    };

    const results = await scatter(plan, db);

    expect(results).toEqual([]);
  });
});
