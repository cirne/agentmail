import { describe, it, expect } from "vitest";
import {
  CLI_USAGE,
  formatNodeCliLongVersion,
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

    it("includes sync, refresh, search, who, status, stats, rebuild-index, mcp, ask, inbox, send, draft, attachment", () => {
      expect(CLI_USAGE).toContain("zmail sync");
      expect(CLI_USAGE).toContain("zmail refresh");
      expect(CLI_USAGE).toContain("zmail rebuild-index");
      expect(CLI_USAGE).toContain("zmail search");
      expect(CLI_USAGE).toContain("zmail who");
      expect(CLI_USAGE).toContain("zmail status");
      expect(CLI_USAGE).toContain("zmail stats");
      expect(CLI_USAGE).toContain("zmail mcp");
      expect(CLI_USAGE).toContain("zmail ask");
      expect(CLI_USAGE).toContain("zmail inbox");
      expect(CLI_USAGE).toContain("zmail send");
      expect(CLI_USAGE).toContain("zmail draft");
      expect(CLI_USAGE).toContain("zmail attachment list");
    });

    it("points to per-command help", () => {
      expect(CLI_USAGE).toContain("zmail <command> --help");
      expect(CLI_USAGE).toContain("Upgrade / reinstall");
      expect(CLI_USAGE).toContain("install.sh");
    });
  });

  describe("formatNodeCliLongVersion", () => {
    it("includes semver, upgrade lines, and install.sh", () => {
      const out = formatNodeCliLongVersion("9.9.9-test");
      expect(out.startsWith("9.9.9-test\n\n")).toBe(true);
      expect(out).toContain("Upgrade / reinstall");
      expect(out).toContain("install.sh");
      expect(out).toContain("Homebrew");
    });
  });

  describe("ONBOARDING_HINT_MISSING_ENV", () => {
    it("tells user to run zmail setup", () => {
      expect(ONBOARDING_HINT_MISSING_ENV).toContain("zmail setup");
    });
  });
});
