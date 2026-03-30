import { describe, it, expect } from "vitest";
import {
  GET_MESSAGES_AUTO_SUMMARY_THRESHOLD,
  resolveGetMessagesShapeDetail,
} from "./get-messages-detail";

describe("resolveGetMessagesShapeDetail", () => {
  it("uses summary when detail omitted and batch exceeds threshold", () => {
    expect(resolveGetMessagesShapeDetail(GET_MESSAGES_AUTO_SUMMARY_THRESHOLD + 1, undefined, false)).toBe(
      "summary"
    );
    expect(resolveGetMessagesShapeDetail(20, undefined, false)).toBe("summary");
  });

  it("uses full (undefined) when detail omitted and batch at or below threshold", () => {
    expect(resolveGetMessagesShapeDetail(GET_MESSAGES_AUTO_SUMMARY_THRESHOLD, undefined, false)).toBe(
      undefined
    );
    expect(resolveGetMessagesShapeDetail(1, undefined, false)).toBe(undefined);
  });

  it("honors explicit full for large batches", () => {
    expect(resolveGetMessagesShapeDetail(20, "full", false)).toBe(undefined);
  });

  it("honors explicit summary for small batches", () => {
    expect(resolveGetMessagesShapeDetail(1, "summary", false)).toBe("summary");
  });

  it("ignores auto rule when raw", () => {
    expect(resolveGetMessagesShapeDetail(20, undefined, true)).toBe(undefined);
    expect(resolveGetMessagesShapeDetail(20, "raw", false)).toBe(undefined);
  });
});
