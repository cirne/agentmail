import { describe, it, expect } from "vitest";
import { parseSearchQuery } from "./query-parse";

describe("parseSearchQuery", () => {
  it("returns empty query for empty input", () => {
    const result = parseSearchQuery("");
    expect(result.query).toBe("");
    expect(result.fromAddress).toBeUndefined();
  });

  it("parses from: operator", () => {
    const result = parseSearchQuery("from:alice@example.com");
    expect(result.fromAddress).toBe("alice@example.com");
    expect(result.query).toBe("");
  });

  it("parses from: with remainder query", () => {
    const result = parseSearchQuery("from:alice@example.com invoice");
    expect(result.fromAddress).toBe("alice@example.com");
    expect(result.query).toBe("invoice");
  });

  it("parses to: operator", () => {
    const result = parseSearchQuery("to:bob@example.com");
    expect(result.toAddress).toBe("bob@example.com");
    expect(result.query).toBe("");
  });

  it("parses subject: operator", () => {
    const result = parseSearchQuery("subject:meeting");
    expect(result.subject).toBe("meeting");
    expect(result.query).toBe("");
  });

  it("parses subject: with quoted value", () => {
    const result = parseSearchQuery('subject:"meeting notes"');
    expect(result.subject).toBe("meeting notes");
    expect(result.query).toBe("");
  });

  it("parses after: with ISO date", () => {
    const result = parseSearchQuery("after:2024-01-01");
    expect(result.afterDate).toBe("2024-01-01");
    expect(result.query).toBe("");
  });

  it("parses after: with relative date", () => {
    const result = parseSearchQuery("after:7d");
    expect(result.afterDate).toBeDefined();
    expect(result.afterDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("parses before: with ISO date", () => {
    const result = parseSearchQuery("before:2024-12-31");
    expect(result.beforeDate).toBe("2024-12-31");
    expect(result.query).toBe("");
  });

  it("parses multiple operators", () => {
    const result = parseSearchQuery("from:alice@example.com subject:invoice after:7d");
    expect(result.fromAddress).toBe("alice@example.com");
    expect(result.subject).toBe("invoice");
    expect(result.afterDate).toBeDefined();
    expect(result.query).toBe("");
  });

  it("extracts remainder query when operators are present", () => {
    const result = parseSearchQuery("from:alice@example.com invoice OR receipt");
    expect(result.fromAddress).toBe("alice@example.com");
    expect(result.query).toBe("invoice OR receipt");
  });

  it("normalizes lowercase 'or' to uppercase 'OR'", () => {
    const result = parseSearchQuery("invoice or receipt");
    expect(result.query).toBe("invoice OR receipt");
  });

  it("normalizes lowercase 'and' to uppercase 'AND'", () => {
    const result = parseSearchQuery("invoice and receipt");
    expect(result.query).toBe("invoice AND receipt");
  });

  it("handles operators in middle of query", () => {
    const result = parseSearchQuery("invoice from:alice@example.com receipt");
    expect(result.fromAddress).toBe("alice@example.com");
    expect(result.query).toBe("invoice receipt");
  });

  it("handles comma-separated values (takes first)", () => {
    const result = parseSearchQuery("from:alice@example.com,bob@example.com");
    expect(result.fromAddress).toBe("alice@example.com");
    expect(result.query).toBe("");
  });

  it("ignores invalid date values", () => {
    const result = parseSearchQuery("after:invalid-date");
    expect(result.afterDate).toBeUndefined();
    // Invalid date is not parsed, so it may or may not appear in query depending on parser behavior
    // The important thing is that afterDate is undefined
  });

  it("handles complex query with all operators", () => {
    const result = parseSearchQuery(
      'from:alice@example.com to:bob@example.com subject:"meeting notes" after:7d before:2024-12-31 invoice OR receipt'
    );
    expect(result.fromAddress).toBe("alice@example.com");
    expect(result.toAddress).toBe("bob@example.com");
    expect(result.subject).toBe("meeting notes");
    expect(result.afterDate).toBeDefined();
    expect(result.beforeDate).toBe("2024-12-31");
    expect(result.query).toBe("invoice OR receipt");
  });

  it("handles query with only text (no operators)", () => {
    const result = parseSearchQuery("invoice receipt");
    expect(result.query).toBe("invoice receipt");
    expect(result.fromAddress).toBeUndefined();
  });

  it("handles whitespace around operators", () => {
    const result = parseSearchQuery("  from:alice@example.com  invoice  ");
    expect(result.fromAddress).toBe("alice@example.com");
    expect(result.query).toBe("invoice");
  });

  it("clears query when it's just OR and multiple filters are present", () => {
    const result = parseSearchQuery("from:marcio OR to:marcio");
    expect(result.fromAddress).toBe("marcio");
    expect(result.toAddress).toBe("marcio");
    expect(result.query).toBe("");
  });

  it("clears query when it's just AND and multiple filters are present", () => {
    const result = parseSearchQuery("from:alice AND to:bob");
    expect(result.fromAddress).toBe("alice");
    expect(result.toAddress).toBe("bob");
    expect(result.query).toBe("");
  });

  it("keeps query when it's OR with text terms", () => {
    const result = parseSearchQuery("from:alice invoice OR receipt");
    expect(result.fromAddress).toBe("alice");
    expect(result.query).toBe("invoice OR receipt");
  });
});
