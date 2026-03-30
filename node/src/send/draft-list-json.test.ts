import { describe, it, expect } from "vitest";
import { SEARCH_AUTO_SLIM_THRESHOLD } from "~/search/search-json-format";
import { buildDraftListJsonPayload, draftListSlimHint } from "./draft-list-json";
import type { DraftListRow } from "./draft-store";

function row(id: string, bodyPreview = "Hello body"): DraftListRow {
  return {
    id,
    path: `/tmp/drafts/${id}.md`,
    kind: "new",
    subject: "Subj",
    bodyPreview,
  };
}

describe("draft-list-json", () => {
  it("auto uses full rows with bodyPreview at threshold", () => {
    const rows = Array.from({ length: SEARCH_AUTO_SLIM_THRESHOLD }, (_, i) => row(`d${i}`));
    const payload = buildDraftListJsonPayload(rows, "auto") as {
      format: string;
      drafts: Array<{ id: string; bodyPreview?: string }>;
      hint?: string;
    };
    expect(payload.format).toBe("full");
    expect(payload.drafts[0]).toHaveProperty("bodyPreview", "Hello body");
    expect(payload.hint).toBeUndefined();
  });

  it("auto uses slim rows above threshold", () => {
    const rows = Array.from({ length: SEARCH_AUTO_SLIM_THRESHOLD + 1 }, (_, i) => row(`d${i}`));
    const payload = buildDraftListJsonPayload(rows, "auto") as {
      format: string;
      drafts: Array<{ id: string; bodyPreview?: string }>;
      hint: string;
    };
    expect(payload.format).toBe("slim");
    expect(payload.drafts[0]).not.toHaveProperty("bodyPreview");
    expect(payload.hint).toBe(draftListSlimHint());
  });

  it("full forces bodyPreview for large lists", () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(`d${i}`));
    const payload = buildDraftListJsonPayload(rows, "full") as {
      format: string;
      drafts: Array<{ bodyPreview?: string }>;
    };
    expect(payload.format).toBe("full");
    expect(payload.drafts[0]).toHaveProperty("bodyPreview");
  });

  it("slim omits bodyPreview for small lists", () => {
    const payload = buildDraftListJsonPayload([row("a")], "slim") as {
      format: string;
      drafts: Array<{ bodyPreview?: string }>;
    };
    expect(payload.format).toBe("slim");
    expect(payload.drafts[0]).not.toHaveProperty("bodyPreview");
  });
});
