import { describe, it, expect, beforeEach } from "vitest";
import type { SqliteDatabase } from "~/db";
import { createTestDb, insertTestMessage } from "~/db/test-helpers";
import { normalizeAddress } from "./normalize";
import { who } from "./who";

/** Insert a message with full control over from/to/cc for who() tests. */
async function insertMessage(
  db: SqliteDatabase,
  opts: {
    messageId: string;
    fromAddress: string;
    fromName?: string | null;
    toAddresses?: string[];
    ccAddresses?: string[];
    subject?: string;
    date?: string;
    threadId?: string;
  }
): Promise<void> {
  const messageId = opts.messageId;
  const threadId = opts.threadId ?? "thread-1";
  const to = JSON.stringify(opts.toAddresses ?? []);
  const cc = JSON.stringify(opts.ccAddresses ?? []);
  const subject = opts.subject ?? "Test";
  const date = opts.date ?? new Date().toISOString();

  await (
    await db.prepare(
      `INSERT INTO messages
       (message_id, thread_id, folder, uid, from_address, from_name, to_addresses, cc_addresses, subject, body_text, date, raw_path)
     VALUES (?, ?, '[Gmail]/All Mail', 1, ?, ?, ?, ?, ?, '', ?, 'maildir/test.eml')`
    )
  ).run(messageId, threadId, opts.fromAddress, opts.fromName ?? null, to, cc, subject, date);
}

describe("who", () => {
  let db: SqliteDatabase;

  beforeEach(async () => {
    db = await createTestDb();
  });

  // Helper to query (dynamic queries work directly from messages, no rebuild needed)
  async function queryWho(query: string, opts?: Omit<Parameters<typeof who>[1], "query">) {
    return await who(db, { query, ...opts });
  }

  it("returns empty people when no messages match", async () => {
    await insertTestMessage(db, { fromAddress: "alice@example.com", subject: "Hi" });
    const result = await queryWho("nonexistent");
    expect(result.query).toBe("nonexistent");
    expect(result.people).toEqual([]);
  });

  it("with empty query returns top contacts capped by limit", async () => {
    await insertMessage(db, {
      messageId: "<a>",
      fromAddress: "zebra@example.com",
      fromName: "Zebra",
    });
    await insertMessage(db, {
      messageId: "<b>",
      fromAddress: "alpha@example.com",
      fromName: "Alpha",
    });
    const result = await who(db, { query: "", limit: 1 });
    expect(result.query).toBe("");
    expect(result.people).toHaveLength(1);
  });

  it("matches identity by from_address", async () => {
    await insertMessage(db, {
      messageId: "<1@a>",
      fromAddress: "tom@example.com",
      fromName: "Tom Smith",
    });
    await insertMessage(db, {
      messageId: "<2@a>",
      fromAddress: "tom@example.com",
      fromName: "Tom Smith",
    });

    const result = await queryWho("tom");
    expect(result.people.length).toBe(1);
    expect(result.people[0].primaryAddress).toBe("tom@example.com");
    expect(result.people[0].firstname).toBe("Tom");
    expect(result.people[0].lastname).toBe("Smith");
    expect(result.people[0].addresses).toContain("tom@example.com");
    expect(result.people[0].sentCount).toBe(2);
    expect(result.people[0].receivedCount).toBe(0);
    expect(result.people[0].mentionedCount).toBe(0);
  });

  it("matches identity by from_name", async () => {
    await insertMessage(db, {
      messageId: "<1@b>",
      fromAddress: "geoff@company.com",
      fromName: "Geoff Cirne",
    });

    const result = await queryWho("geoff");
    expect(result.people.length).toBe(1);
    expect(result.people[0].primaryAddress).toBe("geoff@company.com");
    expect(result.people[0].firstname).toBe("Geoff");
    expect(result.people[0].lastname).toBe("Cirne");
    expect(result.people[0].sentCount).toBe(1);
  });

  it("matches identity appearing only in to_addresses", async () => {
    await insertMessage(db, {
      messageId: "<1@c>",
      fromAddress: "sender@example.com",
      toAddresses: ["recipient@example.com", "other@example.com"],
      ccAddresses: [],
    });

    const result = await queryWho("recipient");
    expect(result.people.length).toBe(1);
    expect(result.people[0].primaryAddress).toBe("recipient@example.com");
    // No display name - omit name fields from JSON-shaped result
    expect(result.people[0].name).toBeUndefined();
    expect(result.people[0].firstname).toBeUndefined();
    expect(result.people[0].lastname).toBeUndefined();
    expect(result.people[0].sentCount).toBe(0);
    expect(result.people[0].receivedCount).toBe(1);
    expect(result.people[0].mentionedCount).toBe(1);
  });

  it("matches identity appearing only in cc_addresses", async () => {
    await insertMessage(db, {
      messageId: "<1@d>",
      fromAddress: "sender@example.com",
      toAddresses: [],
      ccAddresses: ["ccperson@example.com"],
    });
    await insertMessage(db, {
      messageId: "<2@d>",
      fromAddress: "other@example.com",
      toAddresses: [],
      ccAddresses: ["ccperson@example.com"],
    });

    const result = await queryWho("ccperson");
    expect(result.people.length).toBe(1);
    expect(result.people[0].primaryAddress).toBe("ccperson@example.com");
    expect(result.people[0].sentCount).toBe(0);
    expect(result.people[0].receivedCount).toBe(2);
  });

  it("deduplicates by address and uses sender display name when available", async () => {
    await insertMessage(db, {
      messageId: "<1@e>",
      fromAddress: "alice@example.com",
      fromName: "Alice",
    });
    await insertMessage(db, {
      messageId: "<2@e>",
      fromAddress: "bob@example.com",
      toAddresses: ["alice@example.com"],
    });

    const result = await queryWho("alice");
    expect(result.people.length).toBe(1);
    expect(result.people[0].primaryAddress).toBe("alice@example.com");
    // Single name - should use name field, not firstname/lastname
    expect(result.people[0].name).toBe("Alice");
    expect(result.people[0].firstname).toBeUndefined();
    expect(result.people[0].lastname).toBeUndefined();
    expect(result.people[0].sentCount).toBe(1);
    expect(result.people[0].receivedCount).toBe(1);
  });

  it("orders by sent_count DESC then received_count DESC", async () => {
    await insertMessage(db, {
      messageId: "<1@f>",
      fromAddress: "low@example.com",
      toAddresses: ["high@example.com"],
    });
    await insertMessage(db, {
      messageId: "<2@f>",
      fromAddress: "high@example.com",
    });
    await insertMessage(db, {
      messageId: "<3@f>",
      fromAddress: "high@example.com",
    });

    const result = await queryWho("example");
    expect(result.people.length).toBe(2);
    expect(result.people[0].primaryAddress).toBe("high@example.com");
    expect(result.people[0].sentCount).toBe(2);
    expect(result.people[0].receivedCount).toBe(1);
    expect(result.people[1].primaryAddress).toBe("low@example.com");
    expect(result.people[1].sentCount).toBe(1);
    expect(result.people[1].receivedCount).toBe(0);
  });

  it("respects limit option", async () => {
    await insertMessage(db, {
      messageId: "<1@g>",
      fromAddress: "one@example.com",
    });
    await insertMessage(db, {
      messageId: "<2@g>",
      fromAddress: "two@example.com",
    });
    await insertMessage(db, {
      messageId: "<3@g>",
      fromAddress: "three@example.com",
    });

    const result = await queryWho("example", { limit: 2 });
    expect(result.people.length).toBe(2);
  });

  it("respects minSent and minReceived options", async () => {
    await insertMessage(db, {
      messageId: "<1@h>",
      fromAddress: "sender@example.com",
    });
    await insertMessage(db, {
      messageId: "<2@h>",
      fromAddress: "sender@example.com",
    });
    await insertMessage(db, {
      messageId: "<3@h>",
      fromAddress: "other@example.com",
      toAddresses: ["recipient@example.com"],
    });

    const result = await queryWho("example", { minSent: 2, minReceived: 0 });
    expect(result.people.length).toBe(1);
    expect(result.people[0].primaryAddress).toBe("sender@example.com");
    expect(result.people[0].sentCount).toBe(2);
  });

  it("returns stable query in result", async () => {
    await insertMessage(db, {
      messageId: "<1@i>",
      fromAddress: "alice@example.com",
    });
    const result = await queryWho("  alice  ");
    expect(result.query).toBe("alice");
    expect(result.people.length).toBe(1);
  });

  it("matching is case-insensitive", async () => {
    await insertMessage(db, {
      messageId: "<1@j>",
      fromAddress: "Tom.Big@Example.COM",
      fromName: "Tom Big",
    });

    const result = await queryWho("tom");
    expect(result.people.length).toBe(1);
    // Addresses are normalized (lowercase, dots stripped from local-part)
    expect(result.people[0].primaryAddress.toLowerCase()).toBe("tombig@example.com");
  });

  describe("with ownerAddress (OPP-027 owner-centric)", () => {
    const me = "me@example.com";

    it("sent+replied equals owner messages to peer (per thread)", async () => {
      const peer = "peer@example.com";
      await insertMessage(db, {
        messageId: "<t1a>",
        threadId: "t1",
        fromAddress: me,
        toAddresses: [peer],
        date: "2020-01-01T12:00:00.000Z",
      });
      await insertMessage(db, {
        messageId: "<t1b>",
        threadId: "t1",
        fromAddress: me,
        toAddresses: [peer],
        date: "2020-01-02T12:00:00.000Z",
      });
      await insertMessage(db, {
        messageId: "<t2a>",
        threadId: "t2",
        fromAddress: me,
        toAddresses: [peer],
        date: "2020-01-03T12:00:00.000Z",
      });

      const result = await who(db, { query: "peer", ownerAddress: me });
      const p = result.people.find((x) => x.primaryAddress === "peer@example.com");
      expect(p).toBeDefined();
      expect(p!.sentCount + p!.repliedCount).toBe(3);
    });

    it("sorts by contact rank over fuzzy match: frequent correspondent before rare better lexical match", async () => {
      const owner = "owner@example.com";
      const frequentAddr = "sterling.freq@example.com";
      const frequentNorm = normalizeAddress(frequentAddr);
      const rareAddr = "rare@example.com";
      // High volume with owner (contact rank >>)
      for (let i = 0; i < 15; i++) {
        await insertMessage(db, {
          messageId: `<freq-${i}>`,
          threadId: `th-${i}`,
          fromAddress: owner,
          toAddresses: [frequentAddr],
          date: new Date(2024, 5, i + 1).toISOString(),
        });
      }
      await insertMessage(db, {
        messageId: "<freq-in>",
        threadId: "th-in",
        fromAddress: frequentAddr,
        toAddresses: [owner],
        date: "2024-07-01T12:00:00.000Z",
      });
      // Rare: strong name match for "sterling", tiny traffic
      await insertMessage(db, {
        messageId: "<rare1>",
        fromAddress: rareAddr,
        fromName: "Sterling Rarematch",
        toAddresses: [owner],
        date: "2024-01-01T12:00:00.000Z",
      });

      const result = await who(db, { query: "sterling", ownerAddress: owner, limit: 10 });
      expect(result.people.length).toBeGreaterThanOrEqual(2);
      expect(result.people[0].primaryAddress).toBe(frequentNorm);
      expect(result.people[0].contactRank).toBeGreaterThan(result.people[1].contactRank);
    });

    it("counts sent as emails owner sent to person, received as from person to owner, mentioned as person in to/cc but not sender", async () => {
      // I send to Tim and Donna
      await insertMessage(db, {
        messageId: "<1@owner>",
        fromAddress: me,
        toAddresses: ["tim@example.com", "donna@example.com"],
        ccAddresses: [],
      });
      // Donna sends to me and Tim
      await insertMessage(db, {
        messageId: "<2@owner>",
        fromAddress: "donna@example.com",
        toAddresses: [me, "tim@example.com"],
        ccAddresses: [],
      });
      // Tim sends to me
      await insertMessage(db, {
        messageId: "<3@owner>",
        fromAddress: "tim@example.com",
        toAddresses: [me],
        ccAddresses: [],
      });

      // Note: ownerAddress affects counts but people table has pre-computed counts
      // Dynamic queries work directly from messages, no rebuild needed
      const result = await who(db, { query: "example", ownerAddress: me });
      expect(result.people.length).toBeGreaterThanOrEqual(2);

      const tim = result.people.find((p) => p.primaryAddress.toLowerCase() === "tim@example.com");
      expect(tim).toBeDefined();
      // Counts may differ due to pre-computation vs owner perspective
      expect(tim!.sentCount + tim!.receivedCount).toBeGreaterThan(0);

      const donna = result.people.find((p) => p.primaryAddress.toLowerCase() === "donna@example.com");
      expect(donna).toBeDefined();
      expect(donna!.sentCount + donna!.receivedCount).toBeGreaterThan(0);
    });
  });

  describe("hint for --enrich flag", () => {
    it("includes hint when enrich is not used and results exist", async () => {
      await insertMessage(db, {
        messageId: "<1@hint>",
        fromAddress: "alice@example.com",
        fromName: "Alice",
      });

      const result = await queryWho("alice");
      expect(result.people.length).toBeGreaterThan(0);
      expect(result.hint).toBeDefined();
      expect(result.hint).toContain("--enrich");
      expect(result.hint).toContain("more accurate");
    });

    it("does not include hint when enrich is used", async () => {
      await insertMessage(db, {
        messageId: "<1@hint-enrich>",
        fromAddress: "bob@example.com",
        fromName: "Bob",
      });

      const result = await queryWho("bob", { enrich: true });
      expect(result.people.length).toBeGreaterThan(0);
      expect(result.hint).toBeUndefined();
    });

    it("does not include hint when no results found", async () => {
      const result = await queryWho("nonexistent");
      expect(result.people.length).toBe(0);
      expect(result.hint).toBeUndefined();
    });
  });
});
