import { describe, it, expect } from "vitest";
import { parseCliResultFormatMode } from "./result-format-cli";

describe("parseCliResultFormatMode", () => {
  it("accepts auto, full, slim case-insensitively", () => {
    expect(parseCliResultFormatMode("auto")).toBe("auto");
    expect(parseCliResultFormatMode("FULL")).toBe("full");
    expect(parseCliResultFormatMode("Slim")).toBe("slim");
  });

  it("rejects unknown modes with search-aligned message", () => {
    expect(() => parseCliResultFormatMode("wide")).toThrow(
      'Invalid --result-format: "wide". Use auto, full, or slim.'
    );
  });
});
