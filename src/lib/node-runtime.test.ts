import { describe, expect, it } from "vitest";
import {
  isNodeVersionSupportedForZmail,
  ZMAIL_MIN_NODE_MAJOR,
  ZMAIL_MIN_NODE_MINOR,
} from "./node-runtime";

describe("node-runtime", () => {
  it("accepts Node >= min minor on same major", () => {
    expect(isNodeVersionSupportedForZmail(`v${ZMAIL_MIN_NODE_MAJOR}.${ZMAIL_MIN_NODE_MINOR}.0`)).toBe(true);
  });

  it("rejects Node below min minor on same major", () => {
    expect(
      isNodeVersionSupportedForZmail(`v${ZMAIL_MIN_NODE_MAJOR}.${ZMAIL_MIN_NODE_MINOR - 1}.0`),
    ).toBe(false);
  });

  it("accepts newer major", () => {
    expect(isNodeVersionSupportedForZmail("v24.0.0")).toBe(true);
  });

  it("rejects major below min", () => {
    expect(isNodeVersionSupportedForZmail("v20.19.4")).toBe(false);
  });
});
