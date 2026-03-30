import { describe, it, expect } from "vitest";
import { htmlToMarkdown, normalizePlainTextToMarkdown } from "./content-normalize";

describe("normalizePlainTextToMarkdown", () => {
  it("normalizes line endings and trims trailing spaces", () => {
    const input = "Line one  \r\nLine two\t \r\n\r\n\r\nLine three  ";
    const got = normalizePlainTextToMarkdown(input);
    expect(got).toBe("Line one\nLine two\n\nLine three");
  });
});

describe("htmlToMarkdown", () => {
  it("converts basic structure and links", () => {
    const html = `
      <html>
        <body>
          <h1>Receipt</h1>
          <p>Total: <strong>$5.40</strong></p>
          <p>View <a href="https://example.com">details</a>.</p>
          <ul><li>Item A</li><li>Item B</li></ul>
        </body>
      </html>
    `;
    const got = htmlToMarkdown(html);
    expect(got).toContain("Receipt");
    expect(got).toContain("Total: **$5.40**");
    expect(got).toContain("[details](https://example.com)");
    expect(got).toContain("- Item A");
    expect(got).toContain("- Item B");
  });

  it("decodes common entities", () => {
    const html = "<p>Tom &amp; Jerry &nbsp; &lt;3</p>";
    expect(htmlToMarkdown(html)).toBe("Tom & Jerry   <3");
  });
});

