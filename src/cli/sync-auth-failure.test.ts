import { spawn } from "child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
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

/**
 * BUG-007: Sync Silent Authentication Failure
 * 
 * When sync runs with invalid IMAP credentials, it should:
 * 1. Detect the authentication failure
 * 2. Log the error to the sync log
 * 3. Exit with code 1 (not 0)
 * 4. Print an error message to stderr (not "Sync complete!")
 * 
 * This test reproduces the bug and serves as the exit criteria for the fix.
 */
describe("BUG-007: Sync with invalid credentials", () => {
  const originalZmailHome = process.env.ZMAIL_HOME;
  const testHome = join(tmpdir(), "zmail-sync-auth-test-" + Date.now());
  
  beforeEach(() => {
    process.env.ZMAIL_HOME = testHome;
    mkdirSync(testHome, { recursive: true });
    mkdirSync(join(testHome, "logs"), { recursive: true });
    mkdirSync(join(testHome, "data"), { recursive: true });
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

  it("should fail with exit code 1 and error message when IMAP auth fails", async () => {
    // Setup: Create config with invalid credentials (matching bug report scenario)
    writeFileSync(
      join(testHome, "config.json"),
      JSON.stringify({
        imap: {
          host: "imap.gmail.com",
          port: 993,
          user: "test@gmail.com",
        },
        sync: {
          defaultSince: "7d",
          mailbox: "",
          excludeLabels: ["Trash", "Spam"],
        },
      }),
    );
    writeFileSync(join(testHome, ".env"), "ZMAIL_IMAP_PASSWORD=invalid-password-12345\nZMAIL_OPENAI_API_KEY=sk-test123\n");

    // Run sync command (background mode by default)
    const proc = spawn(
      "npx",
      ["tsx", join(import.meta.dirname, "..", "index.ts"), "--", "sync", "--since", "7d"],
      {
        cwd: join(import.meta.dirname, "..", ".."),
        env: { ...process.env, ZMAIL_HOME: testHome },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    proc.stdin?.end();

    const [stdout, stderr, exitCode] = await Promise.all([
      streamToText(proc.stdout),
      streamToText(proc.stderr),
      new Promise<number | null>((resolve) => proc.on("close", resolve)),
    ]);

    const output = stdout + stderr;

    // BUG-007 fix: Should exit with code 1 (not 0)
    expect(exitCode).toBe(1);

    // BUG-007 fix: Should NOT print success message
    expect(output).not.toContain("Sync complete! 0 messages synced and indexed");

    // BUG-007 fix: Should print error message about authentication failure
    expect(output).toMatch(/sync.*fail|auth.*fail|credential|imap.*fail/i);

    // BUG-007 fix: Should log error to sync log file
    const logPath = join(testHome, "logs", "sync.log");
    if (existsSync(logPath)) {
      const logContent = readFileSync(logPath, "utf-8");
      // Should contain error log entry
      expect(logContent).toMatch(/ERROR|Sync failed|connection failed|auth/i);
    }
  }, 30000); // 30s timeout for IMAP connection attempt

  it("should warn when 0 messages synced (may indicate auth failure)", async () => {
    // This test verifies the warning for 0 messages case
    // Setup with invalid credentials
    writeFileSync(
      join(testHome, "config.json"),
      JSON.stringify({
        imap: {
          host: "imap.gmail.com",
          port: 993,
          user: "test@gmail.com",
        },
        sync: {
          defaultSince: "7d",
          mailbox: "",
          excludeLabels: ["Trash", "Spam"],
        },
      }),
    );
    writeFileSync(join(testHome, ".env"), "ZMAIL_IMAP_PASSWORD=invalid-password-12345\nZMAIL_OPENAI_API_KEY=sk-test123\n");

    const proc = spawn(
      "npx",
      ["tsx", join(import.meta.dirname, "..", "index.ts"), "--", "sync", "--since", "7d"],
      {
        cwd: join(import.meta.dirname, "..", ".."),
        env: { ...process.env, ZMAIL_HOME: testHome },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    proc.stdin?.end();

    const [stdout, stderr, exitCode] = await Promise.all([
      streamToText(proc.stdout),
      streamToText(proc.stderr),
      new Promise<number | null>((resolve) => proc.on("close", resolve)),
    ]);

    const output = stdout + stderr;

    // Should exit with error code
    expect(exitCode).toBe(1);

    // Should warn about 0 messages potentially indicating auth failure
    // (This is part of the fix - warning users about potential issues)
    if (output.includes("0 messages")) {
      expect(output).toMatch(/warning|check.*credential|invalid/i);
    }
  }, 30000);
});
