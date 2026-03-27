import { describe, it, expect } from "vitest";
import { composeNewDraftFromInstruction } from "./compose-new-draft";

describe("composeNewDraftFromInstruction", () => {
  it("returns subject and body from mocked LLM JSON", async () => {
    const result = await composeNewDraftFromInstruction({
      to: ["a@b.com"],
      instruction: "Invite to lunch",
      apiKey: "x",
      complete: async () =>
        JSON.stringify({ subject: "Lunch tomorrow?", body: "Hi — **Tuesday** works for me.\n" }),
    });
    expect(result.subject).toBe("Lunch tomorrow?");
    expect(result.body).toContain("Tuesday");
  });

  it("throws when model returns invalid JSON", async () => {
    await expect(
      composeNewDraftFromInstruction({
        to: ["a@b.com"],
        instruction: "x",
        apiKey: "x",
        complete: async () => "not json",
      })
    ).rejects.toThrow(/invalid JSON/);
  });

  it("throws when instruction is empty", async () => {
    await expect(
      composeNewDraftFromInstruction({
        to: ["a@b.com"],
        instruction: "   ",
        apiKey: "x",
        complete: async () => "{}",
      })
    ).rejects.toThrow(/empty/);
  });

  it("throws when to is empty", async () => {
    await expect(
      composeNewDraftFromInstruction({
        to: [],
        instruction: "hello",
        apiKey: "x",
        complete: async () => "{}",
      })
    ).rejects.toThrow(/recipient/);
  });
});
