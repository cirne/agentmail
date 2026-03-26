import { describe, expect, it } from "vitest";
import {
  describeNodeModuleVersion,
  formatNodeAbiMismatchExplanation,
  parseNodeAbiMismatchMessage,
} from "./node-module-version";

describe("parseNodeAbiMismatchMessage", () => {
  it("parses the standard Node dlopen message", () => {
    const msg = `The module '/path/better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 108. This version of Node.js requires
NODE_MODULE_VERSION 127. Please try re-compiling`;
    expect(parseNodeAbiMismatchMessage(msg)).toEqual({
      addonModule: 108,
      runtimeModule: 127,
    });
  });

  it("returns null when pattern missing", () => {
    expect(parseNodeAbiMismatchMessage("random")).toBeNull();
  });
});

describe("describeNodeModuleVersion", () => {
  it("maps known ABI to Node line", () => {
    expect(describeNodeModuleVersion(108)).toContain("18.x");
    expect(describeNodeModuleVersion(108)).toContain("108");
    expect(describeNodeModuleVersion(127)).toContain("22.x");
  });

  it("falls back for unknown module", () => {
    expect(describeNodeModuleVersion(99999)).toContain("99999");
  });
});

describe("formatNodeAbiMismatchExplanation", () => {
  it("returns two lines when parse succeeds", () => {
    const msg =
      "using NODE_MODULE_VERSION 108. This version of Node.js requires NODE_MODULE_VERSION 127.";
    const lines = formatNodeAbiMismatchExplanation(msg);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("108");
    expect(lines[1]).toContain("127");
  });
});
