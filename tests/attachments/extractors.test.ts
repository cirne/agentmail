import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { extractAttachment } from "~/attachments";

const FIXTURES = join(import.meta.dirname, "fixtures");

function fixture(name: string): Buffer {
  return readFileSync(join(FIXTURES, name));
}

describe("PDF extraction", () => {
  test("extracts text from IRS W-9 form", async () => {
    const text = await extractAttachment(fixture("irs-w9-form.pdf"), "application/pdf", "irs-w9-form.pdf");
    expect(text).not.toBeNull();
    expect(text!).toContain("Form");
    expect(text!).toContain("W-9");
    expect(text!).toContain("Taxpayer");
    expect(text!).toContain("Identification Number");
    expect(text!.length).toBeGreaterThan(500);
  });

  test("extracts text from RFC 791 (Internet Protocol)", async () => {
    const text = await extractAttachment(fixture("rfc-791.pdf"), "application/pdf", "rfc-791.pdf");
    expect(text).not.toBeNull();
    expect(text!).toContain("791");
    expect(text!.length).toBeGreaterThan(100);
  });
});

describe("DOCX extraction", () => {
  test("extracts markdown from DOCX", async () => {
    const text = await extractAttachment(
      fixture("sample-doc.docx"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "sample-doc.docx"
    );
    expect(text).not.toBeNull();
    expect(text!).toContain("Lorem ipsum");
    expect(text!.length).toBeGreaterThan(200);
  });
});

describe("XLSX extraction", () => {
  test("converts spreadsheet to CSV with headers", async () => {
    const text = await extractAttachment(
      fixture("sales-data.xlsx"),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "sales-data.xlsx"
    );
    expect(text).not.toBeNull();
    // Should be CSV format with comma-separated values
    const lines = text!.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(100);
    // First line should be headers
    expect(lines[0]).toContain("Segment");
    expect(lines[0]).toContain("Country");
    expect(lines[0]).toContain("Product");
    // Data rows should have values
    expect(lines[1]).toContain("Government");
    // Formula cells must render as values, not [object Object] (BUG-005)
    expect(text).not.toContain("[object Object]");
  });
});

describe("CSV extraction", () => {
  test("passes through CSV content unchanged", async () => {
    const original = fixture("sample-data.csv").toString("utf8");
    const text = await extractAttachment(fixture("sample-data.csv"), "text/csv", "sample-data.csv");
    expect(text).not.toBeNull();
    expect(text!).toBe(original);
    expect(text!).toContain("Date,Product,Region,Units,Revenue");
    expect(text!).toContain("Widget A");
  });
});

describe("HTML extraction", () => {
  test("converts HTML to markdown", async () => {
    const text = await extractAttachment(fixture("sample-page.html"), "text/html", "sample-page.html");
    expect(text).not.toBeNull();
    // Should contain markdown headings (converted from h1/h2)
    expect(text!).toContain("Terms of Service");
    expect(text!).toContain("Acceptance of Terms");
    expect(text!).toContain("18 years old");
    // Should not contain raw HTML tags
    expect(text!).not.toContain("<h1>");
    expect(text!).not.toContain("<p>");
    expect(text!).not.toContain("<li>");
  });
});

describe("TXT extraction", () => {
  test("passes through plain text unchanged", async () => {
    const original = fixture("readme.txt").toString("utf8");
    const text = await extractAttachment(fixture("readme.txt"), "text/plain", "readme.txt");
    expect(text).not.toBeNull();
    expect(text!).toBe(original);
    expect(text!).toContain("Project Status Report");
    expect(text!).toContain("Phase 1 development is complete");
  });
});

describe("unsupported formats", () => {
  test("returns null for unknown mime types", async () => {
    const text = await extractAttachment(Buffer.from("binary data"), "application/octet-stream", "mystery.bin");
    expect(text).toBeNull();
  });

  test("returns null for image files", async () => {
    const text = await extractAttachment(Buffer.from("fake image"), "image/png", "photo.png");
    expect(text).toBeNull();
  });
});
