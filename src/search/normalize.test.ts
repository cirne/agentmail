import { describe, it, expect } from "vitest";
import { normalizeAddress, normalizedLocalPart } from "./normalize";

describe("normalizeAddress", () => {
  it("lowercases addresses", () => {
    expect(normalizeAddress("LewisCirne@MAC.COM")).toBe("lewiscirne@mac.com");
    expect(normalizeAddress("DONNA.WILCOX@GMAIL.COM")).toBe("donnawilcox@gmail.com");
  });

  it("strips dots from local-part", () => {
    expect(normalizeAddress("lewis.cirne@gmail.com")).toBe("lewiscirne@gmail.com");
    expect(normalizeAddress("donna.wilcox@greenlonghorninc.com")).toBe("donnawilcox@greenlonghorninc.com");
  });

  it("strips + aliases", () => {
    expect(normalizeAddress("lewiscirne+bounti@gmail.com")).toBe("lewiscirne@gmail.com");
    expect(normalizeAddress("lewiscirne+elysian@gmail.com")).toBe("lewiscirne@gmail.com");
    expect(normalizeAddress("user+tag+more@example.com")).toBe("user@example.com");
  });

  it("handles edge cases", () => {
    expect(normalizeAddress("lewiscirne@gmail.com")).toBe("lewiscirne@gmail.com"); // Already normalized
    expect(normalizeAddress("user@example.com")).toBe("user@example.com"); // No dots or +
    expect(normalizeAddress("user+tag@example.com")).toBe("user@example.com");
  });

  it("preserves domain dots", () => {
    expect(normalizeAddress("user@mail.example.com")).toBe("user@mail.example.com");
    expect(normalizeAddress("user@sub.domain.example.com")).toBe("user@sub.domain.example.com");
  });

  it("handles invalid emails gracefully", () => {
    expect(normalizeAddress("no-at-sign")).toBe("no-at-sign");
    expect(normalizeAddress("@domain.com")).toBe("@domain.com");
  });
});

describe("normalizedLocalPart", () => {
  it("extracts normalized local-part", () => {
    expect(normalizedLocalPart("lewis.cirne@gmail.com")).toBe("lewiscirne");
    expect(normalizedLocalPart("lewiscirne+bounti@mac.com")).toBe("lewiscirne");
    expect(normalizedLocalPart("DONNA.WILCOX@GMAIL.COM")).toBe("donnawilcox");
  });
});
