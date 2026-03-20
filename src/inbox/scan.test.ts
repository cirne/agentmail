import { describe, it, expect } from "vitest";
import { createTestDb, insertTestMessage } from "~/db/test-helpers";
import { runInboxScan } from "./scan";

describe("runInboxScan", () => {
  it("returns rows picked by classifyBatch", async () => {
    const db = await createTestDb();
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await insertTestMessage(db, { messageId: "<old@x>", subject: "Old", date: old });
    await insertTestMessage(db, { messageId: "<new@x>", subject: "New", date: recent });

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const result = await runInboxScan(db, {
      cutoffIso: cutoff,
      includeNoise: true,
      classifyBatch: async (batch) =>
        batch
          .filter((m) => m.messageId === "<new@x>")
          .map((m) => ({ messageId: m.messageId, note: "needs reply" })),
    });

    expect(result.candidatesScanned).toBe(1);
    expect(result.newMail).toHaveLength(1);
    expect(result.newMail[0].messageId).toBe("<new@x>");
    expect(result.newMail[0].note).toBe("needs reply");
  });

  it("excludes is_noise when includeNoise is false", async () => {
    const db = await createTestDb();
    const d1 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const d2 = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await insertTestMessage(db, { messageId: "<noise@x>", subject: "Promo", date: d1 });
    await insertTestMessage(db, { messageId: "<real@x>", subject: "Real", date: d2 });
    await (await db.prepare("UPDATE messages SET is_noise = 1 WHERE message_id = ?")).run("<noise@x>");

    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await runInboxScan(db, {
      cutoffIso: cutoff,
      includeNoise: false,
      classifyBatch: async (batch) => {
        expect(batch.map((b) => b.messageId)).toEqual(["<real@x>"]);
        return [{ messageId: "<real@x>" }];
      },
    });
  });
});
