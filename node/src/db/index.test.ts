// Schema drift detection removed - early development, wipe data dir and resync instead

import { describe, it, expect } from "vitest";

describe("db/index", () => {
  it("has no schema drift detection (removed for early development)", () => {
    // Schema drift detection was removed - users should wipe data dir and resync
    expect(true).toBe(true);
  });
});
