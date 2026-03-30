import { describe, it, expect } from "vitest";
import {
  SEARCH_AUTO_SLIM_THRESHOLD,
  resolveSearchJsonFormat,
  searchResultToSlimJsonRow,
  searchCliRowToSlimJsonRow,
} from "./search-json-format";
import type { SearchResult } from "~/lib/types";

function sampleResult(over: Partial<SearchResult> = {}): SearchResult {
  return {
    messageId: "<a@b>",
    threadId: "<a@b>",
    fromAddress: "x@y.com",
    fromName: "X",
    subject: "Hi",
    date: "2026-01-01T00:00:00.000Z",
    snippet: "snip",
    rank: -1,
    bodyPreview: "long preview ".repeat(20),
    attachments: [
      { id: 1, filename: "f.pdf", mimeType: "application/pdf", size: 100, extracted: false, index: 1 },
    ],
    ...over,
  };
}

describe("search-json-format", () => {
  it("resolveSearchJsonFormat auto slim when count above threshold", () => {
    expect(
      resolveSearchJsonFormat({
        resultCount: SEARCH_AUTO_SLIM_THRESHOLD + 1,
        preference: "auto",
        allowAutoSlim: true,
      })
    ).toBe("slim");
  });

  it("resolveSearchJsonFormat auto full at threshold", () => {
    expect(
      resolveSearchJsonFormat({
        resultCount: SEARCH_AUTO_SLIM_THRESHOLD,
        preference: "auto",
        allowAutoSlim: true,
      })
    ).toBe("full");
  });

  it("resolveSearchJsonFormat auto never slim when allowAutoSlim false", () => {
    expect(
      resolveSearchJsonFormat({
        resultCount: 100,
        preference: "auto",
        allowAutoSlim: false,
      })
    ).toBe("full");
  });

  it("searchResultToSlimJsonRow drops heavy fields", () => {
    const row = searchResultToSlimJsonRow(sampleResult());
    expect(row).toEqual({
      messageId: "<a@b>",
      subject: "Hi",
      date: "2026-01-01T00:00:00.000Z",
      fromName: "X",
      attachments: 1,
      attachmentTypes: ["pdf"],
    });
    expect(row).not.toHaveProperty("bodyPreview");
    expect(row).not.toHaveProperty("threadId");
  });

  it("searchCliRowToSlimJsonRow uses attachment count and types", () => {
    const three = [
      { id: 1, filename: "a.pdf", mimeType: "application/pdf", size: 1, extracted: false, index: 1 },
      { id: 2, filename: "b.pdf", mimeType: "application/pdf", size: 1, extracted: true, index: 2 },
      { id: 3, filename: "c.txt", mimeType: "text/plain", size: 1, extracted: false, index: 3 },
    ];
    expect(
      searchCliRowToSlimJsonRow({
        messageId: "<m>",
        subject: "S",
        fromName: null,
        date: "2026-01-02T00:00:00.000Z",
        attachmentList: three,
      })
    ).toEqual({
      messageId: "<m>",
      subject: "S",
      date: "2026-01-02T00:00:00.000Z",
      attachments: 3,
      attachmentTypes: ["pdf", "plain"],
    });
  });
});
