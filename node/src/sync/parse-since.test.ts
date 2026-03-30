import { describe, it, expect } from "vitest";
import { parseSinceToDate } from "./parse-since";

describe("parseSinceToDate", () => {
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;

  function approxDaysAgo(days: number): string {
    return new Date(now - days * oneDayMs).toISOString().slice(0, 10);
  }

  it("parses 7d as ~7 days ago", () => {
    const got = parseSinceToDate("7d");
    const expected = approxDaysAgo(7);
    expect(got).toBe(expected);
  });

  it("parses bare number as days (7 → 7 days)", () => {
    const got = parseSinceToDate("7");
    expect(got).toBe(approxDaysAgo(7));
  });

  it("parses 1d as yesterday", () => {
    const got = parseSinceToDate("1d");
    expect(got).toBe(approxDaysAgo(1));
  });

  it("parses 5w as ~35 days ago", () => {
    const got = parseSinceToDate("5w");
    expect(got).toBe(approxDaysAgo(35));
  });

  it("parses 3m as ~90 days ago", () => {
    const got = parseSinceToDate("3m");
    expect(got).toBe(approxDaysAgo(90));
  });

  it("parses 2y as ~730 days ago", () => {
    const got = parseSinceToDate("2y");
    expect(got).toBe(approxDaysAgo(730));
  });

  it("is case-insensitive for unit (7D and 7d)", () => {
    expect(parseSinceToDate("7D")).toBe(parseSinceToDate("7d"));
    expect(parseSinceToDate("2Y")).toBe(parseSinceToDate("2y"));
  });

  it("trims whitespace", () => {
    expect(parseSinceToDate("  7d  ")).toBe(approxDaysAgo(7));
  });

  it("returns valid YYYY-MM-DD", () => {
    const got = parseSinceToDate("30d");
    expect(got).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(() => new Date(got + "T00:00:00Z")).not.toThrow();
  });

  it("throws on empty string", () => {
    expect(() => parseSinceToDate("")).toThrow(/Invalid --since/);
  });

  it("throws on invalid unit", () => {
    expect(() => parseSinceToDate("7x")).toThrow(/Invalid --since/);
  });

  it("throws on non-numeric", () => {
    expect(() => parseSinceToDate("abc")).toThrow(/Invalid --since/);
  });

  it("throws on zero", () => {
    expect(() => parseSinceToDate("0d")).toThrow(/positive/);
  });

  it("throws on negative", () => {
    expect(() => parseSinceToDate("-7d")).toThrow(/Invalid --since/);
  });
});
