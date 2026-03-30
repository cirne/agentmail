import { describe, it, expect } from "vitest";
import { canonicalFirstName, parseName } from "./nicknames";

describe("canonicalFirstName", () => {
  it("resolves nicknames to canonical names", () => {
    expect(canonicalFirstName("lew")).toBe("lewis");
    expect(canonicalFirstName("bob")).toBe("robert");
    expect(canonicalFirstName("bill")).toBe("william");
    expect(canonicalFirstName("matt")).toBe("matthew");
  });

  it("handles unknown names by returning lowercase", () => {
    expect(canonicalFirstName("kirsten")).toBe("kirsten");
    expect(canonicalFirstName("donna")).toBe("donna");
    expect(canonicalFirstName("geoff")).toBe("geoff");
  });

  it("handles case insensitivity", () => {
    expect(canonicalFirstName("LEW")).toBe("lewis");
    expect(canonicalFirstName("Bob")).toBe("robert");
  });

  it("trims whitespace", () => {
    expect(canonicalFirstName("  lew  ")).toBe("lewis");
  });
});

describe("parseName", () => {
  it("parses full names into first and last", () => {
    expect(parseName("Lewis Cirne")).toEqual({ first: "lewis", last: "cirne" });
    expect(parseName("Donna Wilcox")).toEqual({ first: "donna", last: "wilcox" });
  });

  it("handles middle names", () => {
    expect(parseName("Lewis Karl Cirne")).toEqual({ first: "lewis", last: "cirne" });
    expect(parseName("Phillip Seymour Hoffman")).toEqual({ first: "phillip", last: "hoffman" });
  });

  it("strips suffixes", () => {
    expect(parseName("Donna Wilcox Jr.")).toEqual({ first: "donna", last: "wilcox" });
    expect(parseName("John Smith III")).toEqual({ first: "john", last: "smith" });
    expect(parseName("Jane Doe PhD")).toEqual({ first: "jane", last: "doe" });
  });

  it("handles single names", () => {
    expect(parseName("Donna")).toEqual({ first: "donna", last: null });
    expect(parseName("Madonna")).toEqual({ first: "madonna", last: null });
  });

  it("handles null/empty input", () => {
    expect(parseName(null)).toEqual({ first: null, last: null });
    expect(parseName("")).toEqual({ first: null, last: null });
    expect(parseName("   ")).toEqual({ first: null, last: null });
  });

  it("handles case insensitivity", () => {
    expect(parseName("LEWIS CIRNE")).toEqual({ first: "lewis", last: "cirne" });
  });
});
