import { describe, it, expect } from "vitest";
import { isNoreply, isLikelyBot } from "./noreply";

describe("isNoreply", () => {
  it("matches noreply patterns", () => {
    expect(isNoreply("noreply@example.com")).toBe(true);
    expect(isNoreply("no-reply@example.com")).toBe(true);
    expect(isNoreply("mailer-daemon@example.com")).toBe(true);
    expect(isNoreply("postmaster@example.com")).toBe(true);
    expect(isNoreply("notifications@example.com")).toBe(true);
    expect(isNoreply("notification@example.com")).toBe(true);
    expect(isNoreply("donotreply@example.com")).toBe(true);
    expect(isNoreply("bounce@example.com")).toBe(true);
    expect(isNoreply("newsletter@example.com")).toBe(true);
    expect(isNoreply("news@example.com")).toBe(true);
    expect(isNoreply("alerts@example.com")).toBe(true);
    expect(isNoreply("alert@example.com")).toBe(true);
  });

  it("does not match similar addresses", () => {
    expect(isNoreply("donna.noreply@example.com")).toBe(false);
    expect(isNoreply("reply@example.com")).toBe(false);
    expect(isNoreply("lewiscirne@gmail.com")).toBe(false);
    expect(isNoreply("donnawilcox@greenlonghorninc.com")).toBe(false);
  });

  it("handles case insensitivity", () => {
    expect(isNoreply("NO-REPLY@EXAMPLE.COM")).toBe(true);
    expect(isNoreply("Mailer-Daemon@Example.com")).toBe(true);
  });
});

describe("isLikelyBot", () => {
  it("flags addresses with many distinct display names", () => {
    expect(isLikelyBot(11)).toBe(true);
    expect(isLikelyBot(15)).toBe(true);
  });

  it("does not flag addresses with few display names", () => {
    expect(isLikelyBot(1)).toBe(false);
    expect(isLikelyBot(3)).toBe(false);
    expect(isLikelyBot(2)).toBe(false);
  });

  it("threshold is 10", () => {
    expect(isLikelyBot(10)).toBe(false);
    expect(isLikelyBot(11)).toBe(true);
  });
});
