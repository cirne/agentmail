import { spawn } from "child_process";
import { join } from "path";
import { describe, it, expect } from "vitest";

const projectRoot = join(import.meta.dirname, "..");
const indexScript = join(import.meta.dirname, "index.ts");

function streamToText(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString()));
    stream.on("error", reject);
  });
}

async function runEntrypoint(args: string[], env?: Record<string, string>) {
  const proc = spawn("npx", ["tsx", indexScript, "--", ...args], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: env ?? process.env,
  });
  const [out, err, exitCode] = await Promise.all([
    streamToText(proc.stdout),
    streamToText(proc.stderr),
    new Promise<number | null>((resolve) => proc.on("close", resolve)),
  ]);
  return { stdout: out, stderr: err, exitCode };
}

describe("entrypoint onboarding", () => {
  describe("help (no env required)", () => {
    it("--help prints usage and exits 0", async () => {
      const { stdout, exitCode } = await runEntrypoint(["--help"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("zmail");
      expect(stdout).toContain("Usage:");
      expect(stdout).toContain("zmail setup");
    });

    it("-h prints usage and exits 0", async () => {
      const { stdout, exitCode } = await runEntrypoint(["-h"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage:");
    });

    it("help command prints usage and exits 0", async () => {
      const { stdout, exitCode } = await runEntrypoint(["help"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Usage:");
    });
  });

  describe("setup (no env required)", () => {
    it("setup without credentials shows help and exits 1", async () => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        ZMAIL_HOME: "/tmp/zmail-entrypoint-test-" + Date.now(),
      };
      delete env.ZMAIL_EMAIL;
      delete env.ZMAIL_IMAP_PASSWORD;
      delete env.ZMAIL_OPENAI_API_KEY;
      delete env.OPENAI_API_KEY;
      const { stderr, exitCode } = await runEntrypoint(["setup", "--no-validate"], env as Record<string, string>);
      expect(exitCode).toBe(1);
      expect(stderr).toContain("zmail setup");
      expect(stderr).toContain("zmail wizard");
    });
  });

  describe("missing config", () => {
    it("no args without config.json prints quick help and exits 0", async () => {
      // Use a non-existent ZMAIL_HOME to ensure no config exists
      const env = { ...process.env, ZMAIL_HOME: "/tmp/zmail-nonexistent-" + Date.now() };
      const { stdout, stderr, exitCode } = await runEntrypoint([], env);
      expect(exitCode).toBe(0);
      const combined = stdout + stderr;
      expect(combined).toContain("zmail — agent-first email");
      expect(combined).toContain("zmail sync");
      expect(combined).toContain("Run 'zmail --help'");
    });

    it("search without config.json prints error and exits 1", async () => {
      // Use a non-existent ZMAIL_HOME to ensure no config exists
      const env = { ...process.env, ZMAIL_HOME: "/tmp/zmail-nonexistent-" + Date.now() };
      const { stdout, stderr, exitCode } = await runEntrypoint(
        ["search", "foo"],
        env
      );
      expect(exitCode).toBe(1);
      const combined = stdout + stderr;
      expect(combined).toContain("No config found");
      expect(combined).toContain("zmail setup");
    });
  });
});
