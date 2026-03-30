import { describe, it, expect } from "vitest";
import { parseInboxWindowToIsoCutoff } from "./parse-window";

describe("parseInboxWindowToIsoCutoff", () => {
  it("parses 24h as roughly rolling 24 hours", () => {
    const cut = parseInboxWindowToIsoCutoff("24h");
    const t = new Date(cut).getTime();
    const delta = Date.now() - t;
    expect(delta).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(delta).toBeLessThan(25 * 60 * 60 * 1000);
  });

  it("treats bare number as days (rolling)", () => {
    const cut = parseInboxWindowToIsoCutoff("7");
    const t = new Date(cut).getTime();
    const delta = Date.now() - t;
    expect(delta).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(delta).toBeLessThan(8 * 24 * 60 * 60 * 1000);
  });

  it("parses YYYY-MM-DD at UTC midnight", () => {
    expect(parseInboxWindowToIsoCutoff("2024-06-01")).toBe("2024-06-01T00:00:00.000Z");
  });

  it("rejects invalid spec", () => {
    expect(() => parseInboxWindowToIsoCutoff("")).toThrow();
    expect(() => parseInboxWindowToIsoCutoff("xyz")).toThrow();
  });
});
