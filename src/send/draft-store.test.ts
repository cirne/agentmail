import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  writeDraft,
  readDraft,
  listDrafts,
  serializeDraftMarkdown,
  createDraftId,
  normalizeDraftFilename,
  subjectToSlug,
  DRAFT_SUBJECT_SLUG_MAX,
} from "./draft-store";

describe("draft-store", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zmail-draft-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("normalizeDraftFilename strips optional .md", () => {
    expect(normalizeDraftFilename("hello_ab12Cd34")).toBe("hello_ab12Cd34");
    expect(normalizeDraftFilename("hello_ab12Cd34.md")).toBe("hello_ab12Cd34");
    expect(normalizeDraftFilename("  x.md  ")).toBe("x");
  });

  it("readDraft accepts id with or without .md", () => {
    writeDraft(dir, "stem1", { kind: "new", to: ["a@b.com"], subject: "S" }, "b");
    expect(readDraft(dir, "stem1").id).toBe("stem1");
    expect(readDraft(dir, "stem1.md").id).toBe("stem1");
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
    expect(d.id).toBe(id);
    expect(d.frontmatter.id).toBe(id);
    expect(d.frontmatter.to).toEqual(["a@b.com"]);
    expect(d.frontmatter.subject).toBe("Hi");
    expect(d.body).toBe("Hello\n\nWorld");
  });

  it("lists drafts", () => {
    writeDraft(dir, "d1", { kind: "new", to: ["x@y.com"], subject: "S" }, "b");
    const list = listDrafts(dir);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe("d1");
    expect(list[0].path).toMatch(/d1\.md$/);
  });

  it("serializeDraftMarkdown produces parseable document", () => {
    const md = serializeDraftMarkdown(
      { id: "my-draft_a1b2c3d4", kind: "reply", to: ["u@w.com"], subject: "Re: x" },
      "body"
    );
    expect(md).toContain("---");
    expect(md).toContain("id: my-draft_a1b2c3d4");
    expect(md).toContain("kind: reply");
    expect(md).toContain("body");
  });

  it("subjectToSlug normalizes and truncates", () => {
    expect(subjectToSlug("", DRAFT_SUBJECT_SLUG_MAX)).toBe("draft");
    expect(subjectToSlug("Hello World!", DRAFT_SUBJECT_SLUG_MAX)).toBe("hello-world");
    expect(subjectToSlug("café résumé", DRAFT_SUBJECT_SLUG_MAX)).toBe("cafe-resume");
    const long = "word ".repeat(30).trim();
    expect(subjectToSlug(long, DRAFT_SUBJECT_SLUG_MAX).length).toBeLessThanOrEqual(DRAFT_SUBJECT_SLUG_MAX);
  });

  it("createDraftId builds slug_suffix and unique files", () => {
    const id = createDraftId(dir, "Hello There");
    expect(id).toMatch(/^[a-z0-9-]+_[a-zA-Z0-9]{8}$/);
    writeDraft(dir, id, { kind: "new", to: ["a@b.com"], subject: "Hello There" }, "body");
    const d = readDraft(dir, id);
    expect(d.id).toBe(id);

    const id2 = createDraftId(dir, "Hello There");
    expect(id2).not.toBe(id);
    writeDraft(dir, id2, { kind: "new", to: ["a@b.com"], subject: "Hello There" }, "b2");
    expect(listDrafts(dir).length).toBe(2);
  });
});
