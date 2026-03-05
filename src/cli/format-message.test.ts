import { describe, it, expect } from "bun:test";
import { formatMessageLlmFriendly, type MessageRowLike } from "./format-message";

function msg(overrides: Partial<MessageRowLike> = {}): MessageRowLike {
  return {
    message_id: "<id@example.com>",
    thread_id: "<thread@example.com>",
    date: "2026-02-26T22:55:02.000Z",
    from_address: "sender@example.com",
    from_name: null,
    to_addresses: "[]",
    cc_addresses: "[]",
    subject: "Test subject",
    ...overrides,
  };
}

describe("formatMessageLlmFriendly", () => {
  describe("headers", () => {
    it("outputs Message-ID, Thread-ID, Date, From, Subject one per line", () => {
      const out = formatMessageLlmFriendly(msg(), {
        content: { source: "body_text", markdown: "Hello" },
      });
      expect(out).toContain("Message-ID: <id@example.com>");
      expect(out).toContain("Thread-ID: <thread@example.com>");
      expect(out).toContain("Date: 2026-02-26T22:55:02.000Z");
      expect(out).toContain("Subject: Test subject");
    });

    it("formats From as 'Name <address>' when from_name is set", () => {
      const out = formatMessageLlmFriendly(msg({ from_name: "Jane Doe" }), {
        content: { source: "body_text", markdown: "Hi" },
      });
      expect(out).toContain("From: Jane Doe <sender@example.com>");
    });

    it("formats From as address only when from_name is null", () => {
      const out = formatMessageLlmFriendly(msg(), {
        content: { source: "body_text", markdown: "Hi" },
      });
      expect(out).toContain("From: sender@example.com");
    });

    it("omits To and Cc when empty or '[]'", () => {
      const out = formatMessageLlmFriendly(msg(), {
        content: { source: "body_text", markdown: "Hi" },
      });
      expect(out).not.toMatch(/^To:/m);
      expect(out).not.toMatch(/^Cc:/m);
    });

    it("includes To when to_addresses is non-empty", () => {
      const out = formatMessageLlmFriendly(msg({ to_addresses: "a@b.com" }), {
        content: { source: "body_text", markdown: "Hi" },
      });
      expect(out).toContain("To: a@b.com");
    });

    it("includes Cc when cc_addresses is non-empty", () => {
      const out = formatMessageLlmFriendly(msg({ cc_addresses: "c@d.com" }), {
        content: { source: "body_text", markdown: "Hi" },
      });
      expect(out).toContain("Cc: c@d.com");
    });
  });

  describe("plain text (no conversion)", () => {
    it("does not show Content (original: ...) for body_text source", () => {
      const out = formatMessageLlmFriendly(msg(), {
        content: { source: "body_text", markdown: "Plain body" },
      });
      expect(out).not.toContain("Content (original: plain text)");
      expect(out).not.toContain("Content (original: HTML)");
      expect(out).toContain("---");
      expect(out).toContain("Plain body");
    });

    it("does not show Content (original: ...) for text source", () => {
      const out = formatMessageLlmFriendly(msg(), {
        content: { source: "text", markdown: "From parsed body" },
      });
      expect(out).not.toContain("Content (original:");
      expect(out).toContain("---");
      expect(out).toContain("From parsed body");
    });

    it("shows empty body as (no body)", () => {
      const out = formatMessageLlmFriendly(msg(), {
        content: { source: "empty", markdown: "" },
      });
      expect(out).toContain("---");
      expect(out).toContain("(no body)");
    });
  });

  describe("converted from HTML", () => {
    it("shows Content (original: HTML) then --- then markdown body", () => {
      const out = formatMessageLlmFriendly(msg(), {
        content: { source: "html", markdown: "# Heading\n\nParagraph." },
      });
      expect(out).toContain("Content (original: HTML)");
      expect(out).toContain("---");
      expect(out).toContain("# Heading");
      expect(out).toContain("Paragraph.");
    });
  });

  describe("raw EML", () => {
    it("shows Content (original: raw EML) then --- then raw message", () => {
      const eml = "From: x@y.com\nTo: a@b.com\nSubject: Raw\n\nBody here.";
      const out = formatMessageLlmFriendly(msg(), {
        content: { format: "raw", source: "eml", eml },
      });
      expect(out).toContain("Content (original: raw EML)");
      expect(out).toContain("---");
      expect(out).toContain("From: x@y.com");
      expect(out).toContain("Body here.");
    });

  });

  describe("structure", () => {
    it("uses blank line before content hint or separator", () => {
      const out = formatMessageLlmFriendly(msg(), {
        content: { source: "body_text", markdown: "Hi" },
      });
      expect(out).toMatch(/\n\n---\n/);
    });

    it("HTML case has blank line, hint, then --- then body", () => {
      const out = formatMessageLlmFriendly(msg(), {
        content: { source: "html", markdown: "Converted" },
      });
      expect(out).toMatch(/\n\nContent \(original: HTML\)\n---\nConverted/);
    });
  });
});
