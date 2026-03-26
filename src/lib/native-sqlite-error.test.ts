import { describe, expect, it } from "vitest";
import { isNodeNativeAddonAbiError } from "./native-sqlite-error";

describe("isNodeNativeAddonAbiError", () => {
  it("detects NODE_MODULE_VERSION mismatch message", () => {
    const err = new Error(
      "The module '.../better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 108. This version of Node.js requires NODE_MODULE_VERSION 127."
    );
    expect(isNodeNativeAddonAbiError(err)).toBe(true);
  });

  it("detects ERR_DLOPEN_FAILED", () => {
    expect(isNodeNativeAddonAbiError(new Error("ERR_DLOPEN_FAILED"))).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isNodeNativeAddonAbiError(new Error("ENOENT: no such file"))).toBe(false);
  });
});
