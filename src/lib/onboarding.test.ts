import { describe, it, expect } from "vitest";
import {
  CLI_USAGE,
  ONBOARDING_HINT_MISSING_ENV,
} from "./onboarding";

describe("onboarding", () => {
  describe("CLI_USAGE", () => {
    it("includes zmail and Usage", () => {
      expect(CLI_USAGE).toContain("zmail");
      expect(CLI_USAGE).toContain("Usage:");
    });

    it("includes setup command", () => {
      expect(CLI_USAGE).toContain("zmail setup");
    });

    it("includes sync, search, who, status, stats, mcp, ask", () => {
      expect(CLI_USAGE).toContain("zmail sync");
      expect(CLI_USAGE).toContain("zmail search");
      expect(CLI_USAGE).toContain("zmail who");
      expect(CLI_USAGE).toContain("zmail status");
      expect(CLI_USAGE).toContain("zmail stats");
      expect(CLI_USAGE).toContain("zmail mcp");
      expect(CLI_USAGE).toContain("zmail ask");
    });

    it("documents ask vs primitives and points to ASK.md", () => {
      expect(CLI_USAGE).toContain("Ask vs search");
      expect(CLI_USAGE).toContain("docs/ASK.md");
    });
  });

  describe("ONBOARDING_HINT_MISSING_ENV", () => {
    it("tells user to run zmail setup", () => {
      expect(ONBOARDING_HINT_MISSING_ENV).toContain("zmail setup");
    });
  });
});
