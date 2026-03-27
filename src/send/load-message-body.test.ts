import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestDb } from "~/db/test-helpers";
import { loadForwardSourceExcerpt, composeForwardDraftBody } from "./load-message-body";

describe("composeForwardDraftBody", () => {
  it("builds forwarded block without preamble", () => {
    const out = composeForwardDraftBody(
      "",
      {
        fromLine: "Alice <a@b.com>",
        dateLine: "Mon, 1 Jan 2024 00:00:00 GMT",
        subjectLine: "Hello",
        bodyText: "Line one\nLine two",
      }
    );
    expect(out).toContain("---------- Forwarded message ---------");
    expect(out).toContain("From: Alice <a@b.com>");
    expect(out).toContain("Date: Mon, 1 Jan 2024 00:00:00 GMT");
    expect(out).toContain("Subject: Hello");
    expect(out).toContain("Line one\nLine two");
  });

  it("prepends preamble when present", () => {
    const out = composeForwardDraftBody("Please see below.", {
      fromLine: "x@y.com",
      dateLine: "",
      subjectLine: "S",
      bodyText: "body",
    });
    expect(out.startsWith("Please see below.")).toBe(true);
    expect(out).toContain("---------- Forwarded message ---------");
  });
});

describe("loadForwardSourceExcerpt", () => {
  let base: string;
  let maildirPath: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "zmail-fwd-"));
    maildirPath = join(base, "maildir");
    mkdirSync(join(maildirPath, "cur"), { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("loads text body from raw .eml", async () => {
    const eml = [
      "Message-ID: <fwd-src@example.com>",
      "From: Bob <bob@example.com>",
      "Date: Tue, 02 Jan 2024 12:00:00 +0000",
      "Subject: Original subject",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Original body line.",
    ].join("\r\n");
    const rel = "cur/fwd.eml";
    writeFileSync(join(maildirPath, rel), eml);

    const db = await createTestDb();
    const mid = "<fwd-src@example.com>";
    await (
      await db.prepare(
        `INSERT INTO messages
         (message_id, thread_id, folder, uid, from_address, from_name, to_addresses, cc_addresses, subject, body_text, date, raw_path)
         VALUES (?, 't1', '[Gmail]/All Mail', 1, 'x@y.com', NULL, '[]', '[]', 'S', '', ?, ?)`
      )
    ).run(mid, new Date().toISOString(), rel);

    const ex = await loadForwardSourceExcerpt(db, maildirPath, mid);
    expect(ex.fromLine).toContain("bob@example.com");
    expect(ex.subjectLine).toBe("Original subject");
    expect(ex.bodyText).toContain("Original body line.");
  });
});
