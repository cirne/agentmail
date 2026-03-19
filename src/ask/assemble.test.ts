import { describe, it, expect, beforeEach } from "vitest";
import type { SqliteDatabase } from "~/db";
import { createTestDb, insertTestMessage } from "~/db/test-helpers";
import { searchWithMeta } from "~/search";
import { assembleContext } from "./assemble";
import type { SearchPlan } from "./planner";

/**
 * Assemble applies an 80k char cap. Many hits must not exceed the cap.
 */
describe("assembleContext", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  it("does not exceed MAX_CONTEXT_CHARS with many search hits", async () => {
    const MAX_CONTEXT_CHARS = 80000;
    // Subject avoids pattern word so rows tend to be tier 2 (800-char body cap), not tier 1.
    for (let i = 0; i < 55; i++) {
      insertTestMessage(db, {
        messageId: `<bulk-receipt-${i}@example.com>`,
        subject: `Order confirmation #${i}`,
        bodyText: `Receipt confirmation order ${i}. `.repeat(40),
        fromAddress: "store@example.com",
      });
    }

    const { results } = await searchWithMeta(db, {
      query: "receipt",
      includeNoise: false,
      limit: 200,
    });

    expect(results.length).toBeGreaterThanOrEqual(50);

    const plan: SearchPlan = {
      patterns: ["receipt"],
      includeNoise: false,
    };

    const context = await assembleContext(results, plan, db, {
      question: "list my receipts",
    });

    expect(context.length).toBeGreaterThan(1000);
    expect(context.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
  });
});
