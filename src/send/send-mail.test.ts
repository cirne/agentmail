import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createTestDb } from "~/db/test-helpers";
import { sendDraftById } from "./send-mail";
import { writeDraft, createDraftId } from "./draft-store";
import { DEV_SEND_ALLOWLIST } from "./recipients";

describe("sendDraftById", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "zmail-send-draft-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("dryRun succeeds for a new draft without hitting SMTP", async () => {
    const id = createDraftId(dataDir, "Subj");
    writeDraft(
      dataDir,
      id,
      { kind: "new", to: [DEV_SEND_ALLOWLIST], subject: "Subj" },
      "# Hello\n\n**world**"
    );
    const db = await createTestDb();
    const r = await sendDraftById(id, {
      dryRun: true,
      db,
      dataDir,
      maildirPath: "",
    });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
  });
});
