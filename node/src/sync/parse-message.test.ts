import { describe, it, expect } from "vitest";
import { parseRawMessage } from "./parse-message";

describe("parseRawMessage", () => {
  it("extracts plain text body when available", async () => {
    const raw = Buffer.from(
      `From: test@example.com
To: recipient@example.com
Subject: Test
Content-Type: text/plain

Hello world`
    );

    const parsed = await parseRawMessage(raw);
    expect(parsed.bodyText.trim()).toBe("Hello world");
    expect(parsed.bodyHtml).toBeNull();
  });

  it("extracts HTML body and converts to markdown when no plain text", async () => {
    const raw = Buffer.from(
      `From: test@example.com
To: recipient@example.com
Subject: Test
Content-Type: text/html

<h1>Hello</h1>
<p>World</p>`
    );

    const parsed = await parseRawMessage(raw);
    expect(parsed.bodyText).toContain("Hello");
    expect(parsed.bodyText).toContain("World");
    expect(parsed.bodyHtml).toContain("<h1>Hello</h1>");
    // Should be converted to markdown (not raw HTML)
    expect(parsed.bodyText).not.toContain("<h1>");
  });

  it("prefers plain text over HTML when both are available", async () => {
    const raw = Buffer.from(
      `From: test@example.com
To: recipient@example.com
Subject: Test
Content-Type: multipart/alternative; boundary="boundary"

--boundary
Content-Type: text/plain

Plain text version

--boundary
Content-Type: text/html

<h1>HTML version</h1>
--boundary--`
    );

    const parsed = await parseRawMessage(raw);
    // Should prefer plain text
    expect(parsed.bodyText).toContain("Plain text version");
    expect(parsed.bodyText).not.toContain("HTML version");
    expect(parsed.bodyHtml).toContain("HTML version");
  });

  it("extracts message metadata correctly", async () => {
    const raw = Buffer.from(
      `Message-ID: <test@example.com>
From: Alice <alice@example.com>
To: Bob <bob@example.com>
Cc: Charlie <charlie@example.com>
Subject: Test Subject
Date: Mon, 1 Jan 2024 12:00:00 +0000
Content-Type: text/plain

Body content`
    );

    const parsed = await parseRawMessage(raw);
    expect(parsed.messageId).toBe("<test@example.com>");
    expect(parsed.fromAddress).toBe("alice@example.com");
    expect(parsed.fromName).toBe("Alice");
    expect(parsed.toAddresses).toContain("bob@example.com");
    expect(parsed.ccAddresses).toContain("charlie@example.com");
    expect(parsed.subject).toBe("Test Subject");
    expect(parsed.bodyText.trim()).toBe("Body content");
  });

  it("handles HTML-only emails by converting to markdown", async () => {
    const raw = Buffer.from(
      `From: test@example.com
To: recipient@example.com
Subject: Receipt
Content-Type: text/html

<html>
<body>
<h1>Receipt</h1>
<p>Total: <strong>$10.00</strong></p>
<ul>
<li>Item 1</li>
<li>Item 2</li>
</ul>
</body>
</html>`
    );

    const parsed = await parseRawMessage(raw);
    // Should extract text from HTML (converted to markdown)
    expect(parsed.bodyText).toContain("Receipt");
    expect(parsed.bodyText).toContain("Total");
    expect(parsed.bodyText).toContain("$10.00");
    expect(parsed.bodyText).toContain("Item 1");
    expect(parsed.bodyText).toContain("Item 2");
    // Should not contain raw HTML tags
    expect(parsed.bodyText).not.toContain("<h1>");
    expect(parsed.bodyText).not.toContain("<p>");
    expect(parsed.bodyHtml).toContain("<h1>Receipt</h1>");
  });

  describe("noise classification", () => {
    it("does NOT mark transactional email with List-Unsubscribe alone as noise", async () => {
      // Apple Store receipt, GitHub payment receipt, etc. include List-Unsubscribe for CAN-SPAM compliance
      const raw = Buffer.from(
        `From: noreply@apple.com
To: user@example.com
Subject: Your Apple Store receipt
List-Unsubscribe: <https://apple.com/unsubscribe>
Content-Type: text/plain

Thank you for your purchase. Total: $99.00`
      );

      const parsed = await parseRawMessage(raw);
      expect(parsed.isNoise).toBe(false);
    });

    it("marks mailing list with List-Id as noise", async () => {
      const raw = Buffer.from(
        `From: newsletter@example.com
To: user@example.com
Subject: Weekly Newsletter
List-Id: <newsletter.example.com>
Content-Type: text/plain

This week's updates...`
      );

      const parsed = await parseRawMessage(raw);
      expect(parsed.isNoise).toBe(true);
    });

    it("marks mailing list with both List-Unsubscribe and List-Id as noise", async () => {
      const raw = Buffer.from(
        `From: newsletter@example.com
To: user@example.com
Subject: Weekly Newsletter
List-Unsubscribe: <https://example.com/unsubscribe>
List-Id: <newsletter.example.com>
Content-Type: text/plain

This week's updates...`
      );

      const parsed = await parseRawMessage(raw);
      expect(parsed.isNoise).toBe(true);
    });

    it("marks email with Precedence: bulk as noise", async () => {
      const raw = Buffer.from(
        `From: marketing@example.com
To: user@example.com
Subject: Special Offer
Precedence: bulk
Content-Type: text/plain

Limited time offer...`
      );

      const parsed = await parseRawMessage(raw);
      expect(parsed.isNoise).toBe(true);
    });

    it("marks email with Precedence: list as noise", async () => {
      const raw = Buffer.from(
        `From: list@example.com
To: user@example.com
Subject: Discussion Thread
Precedence: list
Content-Type: text/plain

Message content...`
      );

      const parsed = await parseRawMessage(raw);
      expect(parsed.isNoise).toBe(true);
    });

    it("marks email with X-Auto-Response-Suppress as noise", async () => {
      const raw = Buffer.from(
        `From: noreply@example.com
To: user@example.com
Subject: Automated Notification
X-Auto-Response-Suppress: All
Content-Type: text/plain

This is an automated message...`
      );

      const parsed = await parseRawMessage(raw);
      expect(parsed.isNoise).toBe(true);
    });

    it("does NOT mark normal email without noise signals as noise", async () => {
      const raw = Buffer.from(
        `From: alice@example.com
To: bob@example.com
Subject: Meeting Tomorrow
Content-Type: text/plain

Can we meet tomorrow?`
      );

      const parsed = await parseRawMessage(raw);
      expect(parsed.isNoise).toBe(false);
    });
  });

  describe("attachment filtering", () => {
    it("preserves attachments with disposition=attachment in multipart/related", async () => {
      // postal-mime may omit or set related on parts; filter must keep explicit attachment dispositions
      const raw = Buffer.from(
        `Message-ID: <test-related-two-pdf@example.com>
From: a@example.com
To: b@example.com
Subject: Two PDFs
MIME-Version: 1.0
Content-Type: multipart/related; boundary="boundary123"

--boundary123
Content-Type: text/html

<html><body>Hi</body></html>
--boundary123
Content-Type: application/pdf
Content-Disposition: attachment; filename="Will.pdf"

%PDF-1.4 fake1
--boundary123
Content-Type: application/pdf
Content-Disposition: attachment; filename="ancillaries.pdf"

%PDF-1.4 fake2
--boundary123--
`
      );
      const parsed = await parseRawMessage(raw);

      expect(parsed.attachments.length).toBe(2);
      expect(parsed.attachments[0].filename).toContain("Will.pdf");
      expect(parsed.attachments[1].filename).toContain("ancillaries.pdf");
      expect(parsed.attachments[0].mimeType).toBe("application/pdf");
      expect(parsed.attachments[1].mimeType).toBe("application/pdf");
    });

    it("filters inline attachments (disposition=inline)", async () => {
      const raw = Buffer.from(
        `Message-ID: <test@example.com>
From: sender@example.com
To: recipient@example.com
Subject: Test Inline Image
Content-Type: multipart/related; boundary="boundary"

--boundary
Content-Type: text/html

<html><body><img src="cid:image"></body></html>
--boundary
Content-Type: image/png
Content-Disposition: inline; filename="image.png"

[image data]
--boundary--`
      );

      const parsed = await parseRawMessage(raw);
      expect(parsed.attachments.length).toBe(0);
    });

    it("preserves normal attachments (disposition=attachment, related=false)", async () => {
      const raw = Buffer.from(
        `Message-ID: <test@example.com>
From: sender@example.com
To: recipient@example.com
Subject: Test Attachment
Content-Type: multipart/mixed; boundary="boundary"

--boundary
Content-Type: text/plain

Body text.
--boundary
Content-Type: application/pdf
Content-Disposition: attachment; filename="document.pdf"

%PDF-1.4
test content
--boundary--`
      );

      const parsed = await parseRawMessage(raw);
      expect(parsed.attachments.length).toBe(1);
      expect(parsed.attachments[0].filename).toBe("document.pdf");
      expect(parsed.attachments[0].mimeType).toBe("application/pdf");
    });

    it("filters related attachments without explicit disposition=attachment", async () => {
      const raw = Buffer.from(
        `Message-ID: <test@example.com>
From: sender@example.com
To: recipient@example.com
Subject: Test Related
Content-Type: multipart/related; boundary="boundary"

--boundary
Content-Type: text/html

<html><body><img src="cid:logo"></body></html>
--boundary
Content-Type: image/png
Content-ID: <logo>

[image data]
--boundary--`
      );

      const parsed = await parseRawMessage(raw);
      // Related images without explicit attachment disposition should be filtered
      expect(parsed.attachments.length).toBe(0);
    });
  });
});
