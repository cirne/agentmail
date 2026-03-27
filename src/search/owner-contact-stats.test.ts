import { describe, it, expect, beforeEach } from "vitest";
import type { SqliteDatabase } from "~/db";
import { createTestDb, insertTestMessage } from "~/db/test-helpers";
import {
  computeContactRankMapForAddresses,
  inboxCandidatePrefetchLimit,
  sortRowsBySenderContactRank,
} from "./owner-contact-stats";
import { normalizeAddress } from "./normalize";

describe("owner-contact-stats", () => {
  let db: SqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it("inboxCandidatePrefetchLimit caps at 2x candidate cap", () => {
    expect(inboxCandidatePrefetchLimit(80)).toBe(160);
    expect(inboxCandidatePrefetchLimit(150)).toBe(200);
  });

  it("sortRowsBySenderContactRank orders by bilateral signal over one-way inbound", async () => {
    const owner = "me@example.com";
    const friend = "friend@example.com";
    const bulk = "bulk@example.com";
    for (let i = 0; i < 5; i++) {
      await insertTestMessage(db, {
        fromAddress: owner,
        toAddresses: JSON.stringify([friend]),
        subject: "s",
        date: `2024-03-${String(i + 1).padStart(2, "0")}T12:00:00Z`,
      });
    }
    await insertTestMessage(db, {
      fromAddress: friend,
      toAddresses: JSON.stringify([owner]),
      subject: "s",
      date: "2024-03-10T12:00:00Z",
    });
    for (let i = 0; i < 40; i++) {
      await insertTestMessage(db, {
        fromAddress: bulk,
        toAddresses: JSON.stringify([owner]),
        subject: "n",
        date: `2024-03-${String((i % 28) + 1).padStart(2, "0")}T${String(i).padStart(2, "0")}:00:00Z`,
      });
    }

    const rows = [
      { fromAddress: bulk, date: "2024-03-20T12:00:00Z", id: "b" },
      { fromAddress: friend, date: "2024-03-05T12:00:00Z", id: "f" },
    ];
    const sorted = await sortRowsBySenderContactRank(db, owner, rows);
    expect(sorted[0].id).toBe("f");
    expect(sorted[1].id).toBe("b");
  });

  it("computeContactRankMapForAddresses returns higher rank for bilateral peer", async () => {
    const owner = "me@example.com";
    const friend = "friend@example.com";
    const bulk = "bulk@example.com";
    await insertTestMessage(db, {
      fromAddress: owner,
      toAddresses: JSON.stringify([friend]),
    });
    await insertTestMessage(db, {
      fromAddress: friend,
      toAddresses: JSON.stringify([owner]),
    });
    await insertTestMessage(db, {
      fromAddress: bulk,
      toAddresses: JSON.stringify([owner]),
    });
    await insertTestMessage(db, {
      fromAddress: bulk,
      toAddresses: JSON.stringify([owner]),
    });

    const m = await computeContactRankMapForAddresses(db, owner, [friend, bulk]);
    expect((m.get(normalizeAddress(friend)) ?? 0) > (m.get(normalizeAddress(bulk)) ?? 0)).toBe(
      true
    );
  });
});
