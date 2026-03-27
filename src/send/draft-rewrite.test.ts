import { describe, it, expect } from "vitest";
import { rewriteDraftWithInstruction } from "./draft-rewrite";
import type { DraftRecord } from "./draft-store";

describe("rewriteDraftWithInstruction", () => {
  const draft: DraftRecord = {
    id: "x",
    path: "/p",
    frontmatter: { kind: "new", to: ["a@b.com"], subject: "Hi" },
    body: "Hello\n\nOld line about high school.\n\nThanks",
  };

  it("applies instruction via mocked LLM JSON", async () => {
    const result = await rewriteDraftWithInstruction({
      draft,
      instruction: "Remove the high school sentence.",
      apiKey: "sk-test",
      complete: async () =>
        JSON.stringify({
          body: "Hello\n\nThanks",
          subject: null,
        }),
    });
    expect(result.body).toContain("Thanks");
    expect(result.body).not.toContain("high school");
    expect(result.subject).toBeUndefined();
  });

  it("returns subject when model sets it", async () => {
    const result = await rewriteDraftWithInstruction({
      draft,
      instruction: "Change subject to Hello there",
      apiKey: "sk-test",
      complete: async () =>
        JSON.stringify({
          body: draft.body,
          subject: "Hello there",
        }),
    });
    expect(result.subject).toBe("Hello there");
  });

  it("rejects empty instruction", async () => {
    await expect(
      rewriteDraftWithInstruction({
        draft,
        instruction: "   ",
        apiKey: "sk-test",
        complete: async () => "{}",
      })
    ).rejects.toThrow(/empty/i);
  });
});
