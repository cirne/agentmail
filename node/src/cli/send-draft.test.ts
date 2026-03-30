import { describe, it, expect } from "vitest";
import {
  formatDraftViewText,
  formatSendDraftNotFoundMessage,
  draftEditPositionals,
  draftRewritePositionals,
  printDraftRecordOutput,
} from "./send-draft";
import type { DraftRecord } from "~/send";

describe("formatSendDraftNotFoundMessage", () => {
  it("includes draft id, expected path, and draft list hint", () => {
    const msg = formatSendDraftNotFoundMessage("my-draft_abc12345", "/home/u/.zmail/data/drafts/my-draft_abc12345.md");
    expect(msg).toContain("Draft not found: my-draft_abc12345");
    expect(msg).toContain("/home/u/.zmail/data/drafts/my-draft_abc12345.md");
    expect(msg).toContain("zmail draft list");
  });
});

describe("formatDraftViewText", () => {
  it("formats headers and body for reading", () => {
    const d: DraftRecord = {
      id: "abc",
      path: "/tmp/x.md",
      frontmatter: {
        kind: "reply",
        to: ["a@b.com"],
        subject: "Re: Hi",
        sourceMessageId: "<m@x.com>",
      },
      body: "Hello\nthere",
    };
    const out = formatDraftViewText(d);
    expect(out).toContain("Path: /tmp/x.md");
    expect(out).toContain("Kind: reply");
    expect(out).toContain("To: a@b.com");
    expect(out).toContain("Subject: Re: Hi");
    expect(out).toContain("Source-Message-ID: <m@x.com>");
    expect(out).toContain("---");
    expect(out).toContain("Hello\nthere");
  });

  it("omits missing optional fields", () => {
    const d: DraftRecord = {
      id: "n",
      path: "/p",
      frontmatter: { kind: "new", to: ["x@y.com"], subject: "S" },
      body: "body",
    };
    const out = formatDraftViewText(d);
    expect(out).not.toContain("Cc:");
    expect(out).not.toContain("Thread-ID:");
  });
});

describe("draftEditPositionals", () => {
  it("collects id and instruction words; skips --text and --with-body", () => {
    expect(draftEditPositionals(["u1", "remove", "foo", "--text"])).toEqual(["u1", "remove", "foo"]);
    expect(draftEditPositionals(["u1", "x", "--with-body"])).toEqual(["u1", "x"]);
  });

  it("rejects unknown flags", () => {
    expect(() => draftEditPositionals(["u1", "--body", "x"])).toThrow(/unknown flag/);
  });
});

describe("printDraftRecordOutput", () => {
  it("text mode uses formatDraftViewText content", () => {
    const d: DraftRecord = {
      id: "z",
      path: "/z",
      frontmatter: { kind: "new", to: ["a@b.com"], subject: "S" },
      body: "Hi",
    };
    const lines: string[] = [];
    const log = console.log;
    console.log = (m: unknown) => lines.push(String(m));
    try {
      printDraftRecordOutput(d, false);
    } finally {
      console.log = log;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Path: /z");
    expect(lines[0]).toContain("Hi");
  });

  it("JSON omits body by default; includes path and headers", () => {
    const d: DraftRecord = {
      id: "z",
      path: "/zmail/drafts/z.md",
      frontmatter: { kind: "new", to: ["a@b.com"], subject: "S" },
      body: "SECRET",
    };
    const lines: string[] = [];
    const log = console.log;
    console.log = (m: unknown) => lines.push(String(m));
    try {
      printDraftRecordOutput(d, true, false);
    } finally {
      console.log = log;
    }
    const obj = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(obj.path).toBeDefined();
    expect(obj.subject).toBe("S");
    expect(obj.body).toBeUndefined();
  });

  it("JSON with third arg true includes body", () => {
    const d: DraftRecord = {
      id: "z",
      path: "/z",
      frontmatter: { kind: "new", to: ["a@b.com"], subject: "S" },
      body: "Hi",
    };
    const lines: string[] = [];
    const log = console.log;
    console.log = (m: unknown) => lines.push(String(m));
    try {
      printDraftRecordOutput(d, true, true);
    } finally {
      console.log = log;
    }
    expect(JSON.parse(lines[0]!).body).toBe("Hi");
  });
});

describe("draftRewritePositionals", () => {
  it("skips known flags and values", () => {
    expect(
      draftRewritePositionals(["u1", "hello", "world", "--subject", "Subj", "--text"])
    ).toEqual(["u1", "hello", "world"]);
    expect(draftRewritePositionals(["u1", "body", "--with-body"])).toEqual(["u1", "body"]);
  });

  it("skips equals form flags", () => {
    expect(draftRewritePositionals(["u1", "body", "--subject=Other"])).toEqual(["u1", "body"]);
  });
});
