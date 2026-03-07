import { describe, it, expect } from "vitest";
import { extractSignature, extractSignatureData, parseSignatureBlock } from "./signature";

describe("extractSignature", () => {
  it("detects RFC 3676 signature separator", () => {
    const body = "Hello world\n\n-- \nJohn Doe\nCEO, Acme Corp\n+1-555-123-4567";
    const sig = extractSignature(body);
    expect(sig).toContain("John Doe");
    expect(sig).toContain("CEO, Acme Corp");
    expect(sig).toContain("+1-555-123-4567");
  });

  it("detects underscore separator", () => {
    const body = "Message text\n\n___\nJane Smith\nVP Operations";
    const sig = extractSignature(body);
    expect(sig).toContain("Jane Smith");
    expect(sig).toContain("VP Operations");
  });

  it("strips boilerplate", () => {
    const body = "Message\n\n-- \nSent from my iPhone\nJohn Doe";
    const sig = extractSignature(body);
    expect(sig).not.toContain("Sent from my iPhone");
    expect(sig).toContain("John Doe");
  });

  it("returns null when no signature found", () => {
    const body = "Just a regular message with no signature";
    expect(extractSignature(body)).toBeNull();
  });
});

describe("parseSignatureBlock", () => {
  it("extracts phone number", () => {
    const sig = "John Doe\n(512) 555-1234";
    const result = parseSignatureBlock(sig, "john@example.com");
    expect(result.phone).toBeTruthy();
    expect(result.phone).toMatch(/512.*555.*1234/);
  });

  it("extracts title and company", () => {
    const sig = "John Doe\nCEO, Acme Corp";
    const result = parseSignatureBlock(sig, "john@example.com");
    expect(result.title).toBe("CEO");
    expect(result.company).toBe("Acme Corp");
  });

  it("extracts URLs", () => {
    const sig = "John Doe\nhttps://linkedin.com/in/johndoe\nhttps://example.com";
    const result = parseSignatureBlock(sig, "john@example.com");
    expect(result.urls.length).toBeGreaterThan(0);
    expect(result.urls.some((u) => u.includes("linkedin"))).toBe(true);
  });

  it("extracts alternative emails", () => {
    const sig = "John Doe\njohn.personal@gmail.com";
    const result = parseSignatureBlock(sig, "john@company.com");
    expect(result.altEmails).toContain("john.personal@gmail.com");
    expect(result.altEmails).not.toContain("john@company.com");
  });
});

describe("extractSignatureData", () => {
  it("extracts complete signature data", () => {
    const body = "Message\n\n-- \nJohn Doe\nCEO, Acme Corp\n(512) 555-1234\nhttps://example.com";
    const result = extractSignatureData(body, "john@example.com");
    expect(result).toBeTruthy();
    expect(result!.title).toBe("CEO");
    expect(result!.company).toBe("Acme Corp");
    expect(result!.phone).toBeTruthy();
    expect(result!.urls.length).toBeGreaterThan(0);
  });

  it("returns null when no signature", () => {
    const body = "Just a message";
    expect(extractSignatureData(body, "sender@example.com")).toBeNull();
  });

  it("extracts signature with standalone company name and phone", () => {
    const body = `Message text

*Donna Wilcox*
Green Longhorn Inc.

dwilcox@greenlonghorninc.com

512-914-8479


On Sat, Feb 28, 2026 at 1:20 PM Someone <someone@example.com> wrote:`;
    const result = extractSignatureData(body, "dwilcox@greenlonghorninc.com");
    expect(result).toBeTruthy();
    expect(result!.phone).toBeTruthy();
    expect(result!.phone).toMatch(/512.*914.*8479/);
    expect(result!.company).toBe("Green Longhorn Inc.");
  });
});
