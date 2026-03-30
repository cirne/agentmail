import { describe, it, expect } from "vitest";
import { createTestDb, insertTestMessage, insertTestAttachment } from "~/db/test-helpers";
import { listAttachmentsForMessage, indexAttachmentsByMessageId } from "./list-for-message";

describe("listAttachmentsForMessage", () => {
  it("returns rows ordered by filename (index matches CLI list order)", async () => {
    const db = await createTestDb();
    const mid = await insertTestMessage(db, { messageId: "<m@x>" });
    await insertTestAttachment(db, mid, { filename: "z-last.pdf" });
    await insertTestAttachment(db, mid, { filename: "a-first.pdf" });

    const list = await listAttachmentsForMessage(db, mid);
    expect(list.map((r) => r.filename)).toEqual(["a-first.pdf", "z-last.pdf"]);
  });
});

describe("indexAttachmentsByMessageId", () => {
  it("groups by message with 1-based index in filename order", async () => {
    const db = await createTestDb();
    const a = await insertTestMessage(db, { messageId: "<a@x>" });
    const b = await insertTestMessage(db, { messageId: "<b@x>" });
    await insertTestAttachment(db, a, { filename: "b.pdf" });
    await insertTestAttachment(db, a, { filename: "a.pdf" });
    await insertTestAttachment(db, b, { filename: "only.txt", mimeType: "text/plain" });

    const map = await indexAttachmentsByMessageId(db, [a, b]);
    expect(map.get(a)).toEqual([
      {
        id: expect.any(Number),
        filename: "a.pdf",
        mimeType: "application/pdf",
        size: 0,
        extracted: false,
        index: 1,
      },
      {
        id: expect.any(Number),
        filename: "b.pdf",
        mimeType: "application/pdf",
        size: 0,
        extracted: false,
        index: 2,
      },
    ]);
    expect(map.get(b)).toEqual([
      {
        id: expect.any(Number),
        filename: "only.txt",
        mimeType: "text/plain",
        size: 0,
        extracted: false,
        index: 1,
      },
    ]);
  });
});
