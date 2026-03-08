import { describe, it, expect } from "vitest";
import {
  parseJsonArray,
  parseLabels,
  omitEmpty,
  toLeanMessage,
  toSummaryMessage,
  shapeShapedToOutput,
  DEFAULT_BODY_CAP,
  SUMMARY_SNIPPET_LEN,
  type ShapedMessageLike,
} from "./lean-shape";

const NOISE_KEYS = ["id", "uid", "folder", "raw_path", "synced_at"] as const;

function assertNoNoiseFields(obj: Record<string, unknown>) {
  for (const k of NOISE_KEYS) {
    expect(obj).not.toHaveProperty(k);
  }
  const content = obj.content as Record<string, unknown> | undefined;
  if (content) {
    expect(content).not.toHaveProperty("format");
    expect(content).not.toHaveProperty("source");
  }
}

function makeShaped(overrides: Partial<ShapedMessageLike> & { message_id: string }): ShapedMessageLike {
  return {
    message_id: overrides.message_id,
    thread_id: overrides.thread_id ?? "<thread@example.com>",
    from_address: overrides.from_address ?? "alice@example.com",
    from_name: overrides.from_name ?? null,
    to_addresses: overrides.to_addresses ?? "[]",
    cc_addresses: overrides.cc_addresses ?? "[]",
    subject: overrides.subject ?? "Test",
    date: overrides.date ?? "2024-01-01T00:00:00.000Z",
    content: overrides.content ?? { markdown: "Hello world" },
    attachments: overrides.attachments ?? [],
    labels: overrides.labels ?? "[]",
  };
}

describe("parseJsonArray", () => {
  it("returns empty array for null or empty string", () => {
    expect(parseJsonArray(null)).toEqual([]);
    expect(parseJsonArray("")).toEqual([]);
  });
  it("parses JSON string array", () => {
    expect(parseJsonArray('["a@b.com","b@c.com"]')).toEqual(["a@b.com", "b@c.com"]);
  });
  it("returns array as-is when already array", () => {
    expect(parseJsonArray(["x", "y"])).toEqual(["x", "y"]);
  });
});

describe("parseLabels", () => {
  it("returns empty array for null or empty string", () => {
    expect(parseLabels(null)).toEqual([]);
    expect(parseLabels("")).toEqual([]);
  });
  it("parses JSON string array", () => {
    expect(parseLabels('["\\\\Inbox"]')).toEqual(["\\Inbox"]);
  });
});

describe("omitEmpty", () => {
  it("removes null, undefined, empty string, and empty array", () => {
    const obj = {
      a: "keep",
      b: null,
      c: undefined,
      d: "",
      e: [],
      f: [1],
    };
    const out = omitEmpty(obj as Record<string, unknown>);
    expect(out).toEqual({ a: "keep", f: [1] });
  });
  it("keeps false and 0", () => {
    const obj = { a: false, b: 0 };
    const out = omitEmpty(obj as Record<string, unknown>);
    expect(out).toEqual({ a: false, b: 0 });
  });
});

describe("toLeanMessage", () => {
  it("strips noise fields and content.format/source", () => {
    const msg = makeShaped({
      message_id: "<id@example.com>",
      content: { markdown: "Hi", format: "text", source: "body_text" } as { markdown?: string },
    }) as ShapedMessageLike & { id: number; uid: number; folder: string; raw_path: string; synced_at: string };
    (msg as any).id = 1;
    (msg as any).uid = 99;
    (msg as any).folder = "[Gmail]/All Mail";
    (msg as any).raw_path = "cur/x.eml";
    (msg as any).synced_at = "2024-01-01 12:00:00";

    const out = toLeanMessage(msg, 100);
    assertNoNoiseFields(out);
    expect(out.content).toEqual({ markdown: "Hi" });
    expect(out.message_id).toBe("<id@example.com>");
    expect(out.thread_id).toBe("<thread@example.com>");
    expect(out.from_address).toBe("alice@example.com");
    expect(out.subject).toBe("Test");
    expect(out.date).toBe("2024-01-01T00:00:00.000Z");
    expect(out).not.toHaveProperty("bodyTruncated");
  });

  it("truncates body and sets bodyTruncated when over cap", () => {
    const longBody = "x".repeat(300);
    const msg = makeShaped({ message_id: "<id@example.com>", content: { markdown: longBody } });
    const out = toLeanMessage(msg, 100);
    expect((out.content as { markdown: string }).markdown).toHaveLength(100);
    expect(out.bodyTruncated).toBe(true);
  });

  it("omits empty arrays and null from_name", () => {
    const msg = makeShaped({
      message_id: "<id@example.com>",
      to_addresses: "[]",
      cc_addresses: "[]",
      labels: "[]",
      attachments: [],
      from_name: null,
    });
    const out = toLeanMessage(msg, 100);
    expect(out).not.toHaveProperty("to_addresses");
    expect(out).not.toHaveProperty("cc_addresses");
    expect(out).not.toHaveProperty("labels");
    expect(out).not.toHaveProperty("attachments");
    expect(out).not.toHaveProperty("from_name");
  });

  it("includes from_name and non-empty arrays when present", () => {
    const msg = makeShaped({
      message_id: "<id@example.com>",
      from_name: "Alice",
      to_addresses: '["bob@example.com"]',
      attachments: [{ id: 1, filename: "a.pdf" }],
    });
    const out = toLeanMessage(msg, 100);
    expect(out.from_name).toBe("Alice");
    expect(out.to_addresses).toEqual(["bob@example.com"]);
    expect(out.attachments).toEqual([{ id: 1, filename: "a.pdf" }]);
  });
});

describe("toSummaryMessage", () => {
  it("returns minimal shape with snippet and no content/noise", () => {
    const msg = makeShaped({ message_id: "<id@example.com>", subject: "Summary test" });
    const out = toSummaryMessage(msg);
    expect(out.message_id).toBe("<id@example.com>");
    expect(out.subject).toBe("Summary test");
    expect(out.from).toBe("alice@example.com");
    expect(out.date).toBe("2024-01-01T00:00:00.000Z");
    expect(out.snippet).toBe("Hello world");
    expect(out).not.toHaveProperty("content");
    expect(out).not.toHaveProperty("thread_id");
    assertNoNoiseFields(out);
  });

  it("adds ellipsis when body longer than snippet length", () => {
    const longBody = "a".repeat(SUMMARY_SNIPPET_LEN + 50);
    const msg = makeShaped({ message_id: "<id@example.com>", content: { markdown: longBody } });
    const out = toSummaryMessage(msg);
    expect((out.snippet as string).endsWith("…")).toBe(true);
    expect((out.snippet as string).length).toBe(SUMMARY_SNIPPET_LEN + 1);
  });

  it("omits to when empty", () => {
    const msg = makeShaped({ message_id: "<id@example.com>", to_addresses: "[]" });
    const out = toSummaryMessage(msg);
    expect(out).not.toHaveProperty("to");
  });
});

describe("shapeShapedToOutput", () => {
  it("returns lean when useRaw false and no detail", () => {
    const shaped = [makeShaped({ message_id: "<a@x>" }) as ShapedMessageLike & Record<string, unknown>];
    (shaped[0] as any).id = 1;
    (shaped[0] as any).uid = 2;
    const out = shapeShapedToOutput(shaped, { useRaw: false, maxBodyChars: DEFAULT_BODY_CAP });
    expect(out).toHaveLength(1);
    assertNoNoiseFields(out[0] as Record<string, unknown>);
  });

  it("returns summary when detail summary", () => {
    const shaped = [makeShaped({ message_id: "<a@x>" })];
    const out = shapeShapedToOutput(shaped, { useRaw: false, detail: "summary" });
    expect(out).toHaveLength(1);
    const o = out[0] as Record<string, unknown>;
    expect(o).toHaveProperty("snippet");
    expect(o).toHaveProperty("from");
    expect(o).not.toHaveProperty("content");
  });

  it("returns shaped as-is when useRaw true", () => {
    const shaped = [makeShaped({ message_id: "<a@x>" }) as unknown as Record<string, unknown>];
    (shaped[0] as any).id = 1;
    (shaped[0] as any).raw_path = "cur/x.eml";
    const out = shapeShapedToOutput(shaped, { useRaw: true });
    expect(out).toHaveLength(1);
    expect((out[0] as Record<string, unknown>).id).toBe(1);
    expect((out[0] as Record<string, unknown>).raw_path).toBe("cur/x.eml");
  });
});
