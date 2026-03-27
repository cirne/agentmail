import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeDraft, readDraft, listDrafts, serializeDraftMarkdown } from "./draft-store";

describe("draft-store", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zmail-draft-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("roundtrips frontmatter and body", () => {
    const id = "test-id-1";
    writeDraft(
      dir,
      id,
      { kind: "new", to: ["a@b.com"], subject: "Hi" },
      "Hello\n\nWorld"
    );
    const d = readDraft(dir, id);
    expect(d.frontmatter.to).toEqual(["a@b.com"]);
    expect(d.frontmatter.subject).toBe("Hi");
    expect(d.body).toBe("Hello\n\nWorld");
  });

  it("lists drafts", () => {
    writeDraft(dir, "d1", { kind: "new", to: ["x@y.com"], subject: "S" }, "b");
    const list = listDrafts(dir);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe("d1");
  });

  it("serializeDraftMarkdown produces parseable document", () => {
    const md = serializeDraftMarkdown({ kind: "reply", to: ["u@w.com"], subject: "Re: x" }, "body");
    expect(md).toContain("---");
    expect(md).toContain("kind: reply");
    expect(md).toContain("body");
  });
});
