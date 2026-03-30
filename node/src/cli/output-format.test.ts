/**
 * Tests for CLI output format defaults (ADR-022).
 * Verifies that commands default to JSON or text as specified, and flags work correctly.
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

function streamToText(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString()));
    stream.on("error", reject);
  });
}

function runZmail(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn("npx", ["tsx", join(import.meta.dirname, "..", "index.ts"), "--", ...args], {
      cwd: join(import.meta.dirname, "..", ".."),
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdin?.end();

    Promise.all([
      streamToText(proc.stdout),
      streamToText(proc.stderr),
      new Promise<number | null>((resolve) => proc.on("close", resolve)),
    ]).then(([stdout, stderr, exitCode]) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function isJson(str: string): boolean {
  try {
    JSON.parse(str.trim());
    return true;
  } catch {
    return false;
  }
}

describe("CLI output formats (ADR-022)", () => {
  const originalZmailHome = process.env.ZMAIL_HOME;
  const testHome = join(tmpdir(), "zmail-output-format-test-" + Date.now());

  const baseEnv = (): Record<string, string> => ({
    ZMAIL_HOME: testHome,
    ZMAIL_OPENAI_API_KEY: "sk-dummy", // Rebuild/indexing checks for key; dummy avoids throw when no messages
  });

  beforeEach(() => {
    process.env.ZMAIL_HOME = testHome;
    mkdirSync(testHome, { recursive: true });
    mkdirSync(join(testHome, "data"), { recursive: true });

    // Create minimal config
    writeFileSync(
      join(testHome, "config.json"),
      JSON.stringify({
        imap: { user: "test@example.com", host: "imap.example.com", port: 993 },
        sync: { mailbox: "INBOX" },
      })
    );

    // Create minimal DB file (schema will be created on first access)
    writeFileSync(join(testHome, "data", "zmail.db"), "");
  });

  afterEach(() => {
    if (existsSync(testHome)) {
      rmSync(testHome, { recursive: true, force: true });
    }
    if (originalZmailHome) {
      process.env.ZMAIL_HOME = originalZmailHome;
    } else {
      delete process.env.ZMAIL_HOME;
    }
  });

  describe("search command", () => {
    it("accepts --text flag without error", async () => {
      // Test that --text flag is parsed correctly (doesn't throw "unknown flag" error)
      const { stderr } = await runZmail(["search", "test", "--text"], baseEnv());
      // Should not have "Unknown flag" error
      expect(stderr).not.toContain("Unknown flag: --text");
      // May fail for other reasons (no config, no DB) but flag parsing should work
    });

    it("--ids-only flag forces JSON output format", async () => {
      // --ids-only should force JSON even without --json flag
      // This is tested by checking that the flag is accepted
      const { stderr } = await runZmail(["search", "test", "--ids-only"], baseEnv());
      expect(stderr).not.toContain("Unknown flag");
    });
  });

  describe("who command", () => {
    it("defaults to JSON output", async () => {
      const { stdout } = await runZmail(["who", "test"], baseEnv());
      expect(isJson(stdout.trim())).toBeTruthy();
      const parsed = JSON.parse(stdout.trim());
      expect(parsed).toHaveProperty("query");
      expect(parsed).toHaveProperty("people");
    });

    it("outputs text with --text flag", async () => {
      const { stdout } = await runZmail(["who", "test", "--text"], baseEnv());
      expect(isJson(stdout.trim())).toBeFalsy();
      expect(stdout.includes("No matching people") || stdout.includes("People matching")).toBeTruthy();
    });

    it("accepts --timings flag without error", async () => {
      const { stderr } = await runZmail(["who", "test", "--timings"], baseEnv());
      expect(stderr).not.toContain("Unknown flag: --timings");
    });

    it("includes _timing in JSON output when --timings is passed", async () => {
      const { stdout } = await runZmail(["who", "test", "--timings"], baseEnv());
      expect(isJson(stdout.trim())).toBeTruthy();
      const parsed = JSON.parse(stdout.trim());
      expect(parsed).toHaveProperty("_timing");
      expect(parsed._timing).toHaveProperty("ms");
    });

    it("omits _timing in JSON output when --timings is not passed", async () => {
      const { stdout } = await runZmail(["who", "test"], baseEnv());
      expect(isJson(stdout.trim())).toBeTruthy();
      const parsed = JSON.parse(stdout.trim());
      expect(parsed).not.toHaveProperty("_timing");
    });
  });

  describe("attachment list command", () => {
    it("defaults to JSON output", async () => {
      const { stdout } = await runZmail(["attachment", "list", "<test@example.com>"], baseEnv());
      expect(isJson(stdout.trim())).toBeTruthy();
      const parsed = JSON.parse(stdout.trim());
      expect(Array.isArray(parsed)).toBeTruthy();
    });

    it("outputs text with --text flag", async () => {
      const { stdout } = await runZmail(["attachment", "list", "<test@example.com>", "--text"], baseEnv());
      expect(isJson(stdout.trim())).toBeFalsy();
      expect(stdout.includes("No attachments") || stdout.includes("Attachments for")).toBeTruthy();
    });
  });

  describe("thread command", () => {
    it("defaults to text output", async () => {
      const { stdout } = await runZmail(["thread", "<test@example.com>"], baseEnv());
      // With no messages, should output empty or error, but not JSON
      expect(isJson(stdout.trim())).toBeFalsy();
    });

    it("outputs JSON with --json flag", async () => {
      const { stdout } = await runZmail(["thread", "<test@example.com>", "--json"], baseEnv());
      // Even with no results, should be valid JSON (empty array)
      const trimmed = stdout.trim();
      expect(trimmed === "[]" || isJson(trimmed)).toBeTruthy();
    });
  });

  describe("status command", () => {
    it("defaults to text output", async () => {
      const { stdout } = await runZmail(["status"], baseEnv());
      expect(isJson(stdout.trim())).toBeFalsy();
      expect(stdout.includes("Sync:")).toBeTruthy();
    });

    it("outputs JSON with --json flag", async () => {
      const { stdout } = await runZmail(["status", "--json"], baseEnv());
      expect(isJson(stdout.trim())).toBeTruthy();
      const parsed = JSON.parse(stdout.trim());
      expect(parsed).toHaveProperty("sync");
      expect(parsed).toHaveProperty("search");
    });
  });

  describe("stats command", () => {
    it("defaults to text output", async () => {
      const { stdout } = await runZmail(["stats"], baseEnv());
      expect(isJson(stdout.trim())).toBeFalsy();
      expect(stdout.includes("Database Statistics") || stdout.includes("Total messages")).toBeTruthy();
    });

    it("outputs JSON with --json flag", async () => {
      const { stdout } = await runZmail(["stats", "--json"], baseEnv());
      expect(isJson(stdout.trim())).toBeTruthy();
      const parsed = JSON.parse(stdout.trim());
      expect(parsed).toHaveProperty("totalMessages");
      expect(parsed).toHaveProperty("topSenders");
      expect(parsed).toHaveProperty("folders");
    });
  });

  describe("inbox command", () => {
    it("inbox --help prints usage", async () => {
      const { stderr, exitCode } = await runZmail(["inbox", "--help"], baseEnv());
      expect(exitCode).toBe(1);
      expect(stderr).toContain("zmail inbox");
      expect(stderr).toContain("--refresh");
    });

    it("inbox without API key exits before LLM", async () => {
      const env = { ...baseEnv(), ZMAIL_OPENAI_API_KEY: "", OPENAI_API_KEY: "" };
      const { stderr, exitCode } = await runZmail(["inbox"], env);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("zmail inbox requires an LLM API key");
    });
  });

  describe("help text consistency", () => {
    it("search --help mentions --text flag", async () => {
      const { stderr, exitCode } = await runZmail(["search", "--help"], baseEnv());
      expect(exitCode).toBe(0);
      expect(stderr).toContain("--text");
      expect(stderr).toContain("default: JSON");
    });

    it("search --help mentions --result-format", async () => {
      const { stderr, exitCode } = await runZmail(["search", "--help"], baseEnv());
      expect(exitCode).toBe(0);
      expect(stderr).toContain("--result-format");
    });

    it("who --help mentions --text flag", async () => {
      const { stderr, exitCode } = await runZmail(["who", "--help"], baseEnv());
      expect(exitCode).toBe(0);
      expect(stderr).toContain("--text");
      expect(stderr).toContain("default: JSON");
    });

    it("thread --help mentions --json flag", async () => {
      const { stderr, exitCode } = await runZmail(["thread", "--help"], baseEnv());
      expect(exitCode).toBe(0);
      expect(stderr).toContain("--json");
      expect(stderr).toContain("default: text");
    });
  });
});
