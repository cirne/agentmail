import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestDb } from "~/db/test-helpers";
import { loadThreadingFromSourceMessage } from "./threading";

describe("loadThreadingFromSourceMessage", () => {
  let base: string;
  let maildirPath: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "zmail-thread-"));
    maildirPath = join(base, "maildir");
    mkdirSync(join(maildirPath, "cur"), { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("builds In-Reply-To and References from raw .eml", async () => {
    const eml = [
      "Message-ID: <orig@example.com>",
      "References: <a@older.com>",
      "Subject: Hello",
      "",
      "Body",
      "",
    ].join("\r\n");
    const rel = "cur/msg.eml";
    writeFileSync(join(maildirPath, rel), eml);

    const db = await createTestDb();
    const mid = "<orig@example.com>";
    await (
      await db.prepare(
        `INSERT INTO messages
         (message_id, thread_id, folder, uid, from_address, from_name, to_addresses, cc_addresses, subject, body_text, date, raw_path)
         VALUES (?, 't1', '[Gmail]/All Mail', 1, 'x@y.com', NULL, '[]', '[]', 'S', '', ?, ?)`
      )
    ).run(mid, new Date().toISOString(), rel);

    const t = await loadThreadingFromSourceMessage(db, maildirPath, mid);
    expect(t.inReplyTo).toBe("<orig@example.com>");
    expect(t.references).toContain("<orig@example.com>");
    expect(t.references).toContain("<a@older.com>");
  });
});
