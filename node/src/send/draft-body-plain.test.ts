import { describe, it, expect } from "vitest";
import { draftMarkdownToPlainText } from "./draft-body-plain";

describe("draftMarkdownToPlainText", () => {
  it("strips common markdown while keeping readable text", () => {
    const md = "# Title\n\n- one\n- **two**\n\n[link](https://example.com)";
    const out = draftMarkdownToPlainText(md);
    expect(out).not.toContain("#");
    expect(out).not.toContain("**");
    expect(out.toLowerCase()).toContain("title");
    expect(out).toContain("one");
    expect(out).toContain("two");
  });

  it("leaves plain prose largely unchanged", () => {
    const plain = "Hello world.\n\nSecond paragraph.";
    expect(draftMarkdownToPlainText(plain)).toBe(plain);
  });

  it("handles empty string", () => {
    expect(draftMarkdownToPlainText("")).toBe("");
  });
});
