import { spawn } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
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
 * BUG-009: Wizard Crash on Non-Interactive Stdin
 *
 * When wizard runs with non-TTY stdin, it should:
 * 1. Detect non-TTY mode
 * 2. Exit with code 1 (not crash)
 * 3. Print a clear error message (not a stack trace)
 *
 * This test reproduces the bug and serves as the exit criteria for the fix.
 *
 * @inquirer/prompts (via util.styleText) requires Node 20+; package engines require Node 22.5+.
 */
const nodeMajor = Number(process.versions.node.split(".")[0]);
describe.skipIf(nodeMajor < 20)("BUG-009: Wizard with non-interactive stdin", () => {
  const originalZmailHome = process.env.ZMAIL_HOME;
  const testHome = join(tmpdir(), "zmail-wizard-test-" + Date.now());
  
  beforeEach(() => {
    process.env.ZMAIL_HOME = testHome;
    mkdirSync(testHome, { recursive: true });
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

  it("should exit gracefully with error message when stdin is not a TTY", async () => {
    // Simulate non-TTY stdin by piping empty input
    const proc = spawn(
      "npx",
      ["tsx", join(import.meta.dirname, "..", "index.ts"), "--", "wizard"],
      {
        cwd: join(import.meta.dirname, "..", ".."),
        env: { ...process.env, ZMAIL_HOME: testHome },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    // Close stdin immediately to simulate non-TTY
    proc.stdin?.end();

    const [stdout, stderr, exitCode] = await Promise.all([
      streamToText(proc.stdout),
      streamToText(proc.stderr),
      new Promise<number | null>((resolve) => proc.on("close", resolve)),
    ]);

    const output = stdout + stderr;

    // BUG-009 fix: Should exit with code 1 (not crash with unhandled exception)
    expect(exitCode).toBe(1);

    // BUG-009 fix: Should print clear error message
    expect(output).toMatch(/Wizard requires an interactive terminal/i);
    expect(output).toMatch(/zmail setup/i);

    // BUG-009 fix: Should NOT print stack trace
    expect(output).not.toContain("ExitPromptError");
    expect(output).not.toContain("at file://");
    expect(output).not.toContain("node_modules");
  });

  it("should exit gracefully when stdin is piped with empty input", async () => {
    // Simulate: echo "" | zmail wizard
    const proc = spawn(
      "sh",
      ["-c", `echo "" | npx tsx ${join(import.meta.dirname, "..", "index.ts")} -- wizard`],
      {
        cwd: join(import.meta.dirname, "..", ".."),
        env: { ...process.env, ZMAIL_HOME: testHome },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const [stdout, stderr, exitCode] = await Promise.all([
      streamToText(proc.stdout),
      streamToText(proc.stderr),
      new Promise<number | null>((resolve) => proc.on("close", resolve)),
    ]);

    const output = stdout + stderr;

    // Should exit with code 1
    expect(exitCode).toBe(1);

    // Should print clear error message
    expect(output).toMatch(/Wizard requires an interactive terminal/i);

    // Should NOT print stack trace
    expect(output).not.toContain("ExitPromptError");
  });
});
