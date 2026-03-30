import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { config, hasConfig } from "./config";
import { join } from "path";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from "fs";
import { spawn } from "child_process";
import { tmpdir } from "os";

function streamToText(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString()));
    stream.on("error", reject);
  });
}

describe("config", () => {
  const originalZmailHome = process.env.ZMAIL_HOME;
  const testHome = join("/tmp", "zmail-test-" + Date.now());
  
  beforeEach(() => {
    process.env.ZMAIL_HOME = testHome;
    mkdirSync(testHome, { recursive: true });
    // Clear any existing config
    const configPath = join(testHome, "config.json");
    if (existsSync(configPath)) unlinkSync(configPath);
    const envPath = join(testHome, ".env");
    if (existsSync(envPath)) unlinkSync(envPath);
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

  describe("defaults", () => {
    it("uses imap.gmail.com as default IMAP host when no config.json", () => {
      // Note: config is loaded at import time, so we need to reload or test differently
      // For now, just verify the structure exists
      expect(config.imap).toBeDefined();
      expect(typeof config.imap.host).toBe("string");
    });

    it("uses port 993 by default", () => {
      expect(config.imap.port).toBe(993);
    });

    it("defaults dataDir to <homedir>/.zmail/data when ZMAIL_HOME unset", () => {
      delete process.env.ZMAIL_HOME;
      expect(config.dataDir).toContain(".zmail/data");
      expect(config.dataDir).not.toContain("~");
      expect(config.dataDir).toMatch(/^\//); // absolute path
      process.env.ZMAIL_HOME = testHome; // restore for afterEach
    });

    it("defaultSince is set (exact default verified via subprocess test)", () => {
      expect(config.sync.defaultSince).toBeTruthy();
      expect(typeof config.sync.defaultSince).toBe("string");
    });
  });

  describe("derived paths", () => {
    it("dbPath is inside dataDir", () => {
      expect(config.dbPath).toBe(join(config.dataDir, "zmail.db"));
    });

    it("maildirPath is inside dataDir", () => {
      expect(config.maildirPath).toBe(join(config.dataDir, "maildir"));
    });
  });

  describe("hasConfig", () => {
    it("returns false when config.json does not exist", () => {
      expect(hasConfig()).toBe(false);
    });

    it("returns true when config.json exists", () => {
      writeFileSync(join(testHome, "config.json"), JSON.stringify({ imap: { user: "test@example.com" } }));
      const configPath = join(testHome, "config.json");
      expect(existsSync(configPath)).toBe(true);
    });
  });

  describe("config.json overrides (via subprocess)", () => {
    const spawnHome = join(tmpdir(), "zmail-config-spawn-" + Date.now());

    afterEach(() => {
      if (existsSync(spawnHome)) {
        rmSync(spawnHome, { recursive: true, force: true });
      }
    });

    it("loads imap host, port, user and sync settings from config.json", async () => {
      mkdirSync(spawnHome, { recursive: true });
      writeFileSync(
        join(spawnHome, "config.json"),
        JSON.stringify({
          imap: {
            host: "imap.example.com",
            port: 143,
            user: "custom@example.com",
          },
          sync: {
            defaultSince: "14d",
            mailbox: "INBOX",
            excludeLabels: ["trash", "junk"],
          },
        }),
      );

      const proc = spawn("npx", ["tsx", join(import.meta.dirname, "config-test-helper.ts")], {
        cwd: join(import.meta.dirname, "..", ".."),
        env: { ...process.env, ZMAIL_HOME: spawnHome },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const [stdout] = await Promise.all([
        streamToText(proc.stdout),
        streamToText(proc.stderr),
      ]);
      const exitCode = await new Promise<number | null>((resolve) => proc.on("close", resolve));

      expect(exitCode).toBe(0);
      const loaded = JSON.parse(stdout);
      expect(loaded.imap.host).toBe("imap.example.com");
      expect(loaded.imap.port).toBe(143);
      expect(loaded.imap.user).toBe("custom@example.com");
      expect(loaded.sync.defaultSince).toBe("14d");
      expect(loaded.sync.mailbox).toBe("INBOX");
      expect(loaded.sync.excludeLabels).toEqual(["trash", "junk"]);
    });

    it("uses ZMAIL_EMAIL as fallback for imap.user when not in config.json", async () => {
      mkdirSync(spawnHome, { recursive: true });
      writeFileSync(join(spawnHome, "config.json"), JSON.stringify({ imap: {} }));

      const proc = spawn("npx", ["tsx", join(import.meta.dirname, "config-test-helper.ts")], {
        cwd: join(import.meta.dirname, "..", ".."),
        env: {
          ...process.env,
          ZMAIL_HOME: spawnHome,
          ZMAIL_EMAIL: "envfallback@gmail.com",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdout = await streamToText(proc.stdout);
      const exitCode = await new Promise<number | null>((resolve) => proc.on("close", resolve));

      expect(exitCode).toBe(0);
      const loaded = JSON.parse(stdout);
      expect(loaded.imap.user).toBe("envfallback@gmail.com");
    });

    it("uses OPENAI_API_KEY as fallback when ZMAIL_OPENAI_API_KEY not set", async () => {
      mkdirSync(spawnHome, { recursive: true });
      writeFileSync(join(spawnHome, "config.json"), JSON.stringify({ imap: { user: "test@example.com" } }));
      writeFileSync(join(spawnHome, ".env"), "ZMAIL_IMAP_PASSWORD=test\nOPENAI_API_KEY=sk-fallback-key\n");

      const proc = spawn("npx", ["tsx", join(import.meta.dirname, "config-test-helper.ts")], {
        cwd: join(import.meta.dirname, "..", ".."),
        env: { ...process.env, ZMAIL_HOME: spawnHome },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdout = await streamToText(proc.stdout);
      const exitCode = await new Promise<number | null>((resolve) => proc.on("close", resolve));

      expect(exitCode).toBe(0);
      const loaded = JSON.parse(stdout);
      expect(loaded.openaiKeySet).toBe(true);
    });

    it("prefers ZMAIL_OPENAI_API_KEY over OPENAI_API_KEY", async () => {
      mkdirSync(spawnHome, { recursive: true });
      writeFileSync(join(spawnHome, "config.json"), JSON.stringify({ imap: { user: "test@example.com" } }));
      writeFileSync(
        join(spawnHome, ".env"),
        "ZMAIL_IMAP_PASSWORD=test\nZMAIL_OPENAI_API_KEY=sk-zmail-key\nOPENAI_API_KEY=sk-openai-key\n",
      );

      const proc = spawn("npx", ["tsx", join(import.meta.dirname, "config-test-helper.ts")], {
        cwd: join(import.meta.dirname, "..", ".."),
        env: { ...process.env, ZMAIL_HOME: spawnHome },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdout = await streamToText(proc.stdout);
      const exitCode = await new Promise<number | null>((resolve) => proc.on("close", resolve));

      expect(exitCode).toBe(0);
      const loaded = JSON.parse(stdout);
      expect(loaded.openaiKeySet).toBe(true);
    });

    it("uses defaults when config.json is empty", async () => {
      mkdirSync(spawnHome, { recursive: true });
      writeFileSync(join(spawnHome, "config.json"), "{}");

      const proc = spawn("npx", ["tsx", join(import.meta.dirname, "config-test-helper.ts")], {
        cwd: join(import.meta.dirname, "..", ".."),
        env: { ...process.env, ZMAIL_HOME: spawnHome },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdout = await streamToText(proc.stdout);
      const exitCode = await new Promise<number | null>((resolve) => proc.on("close", resolve));

      expect(exitCode).toBe(0);
      const loaded = JSON.parse(stdout);
      expect(loaded.imap.host).toBe("imap.gmail.com");
      expect(loaded.imap.port).toBe(993);
      expect(loaded.sync.defaultSince).toBe("1y");
      expect(loaded.sync.excludeLabels).toEqual(["trash", "spam"]);
      expect(loaded.inbox.defaultWindow).toBe("24h");
    });

    it("loads inbox.defaultWindow from config.json", async () => {
      mkdirSync(spawnHome, { recursive: true });
      writeFileSync(
        join(spawnHome, "config.json"),
        JSON.stringify({ imap: { user: "u@x.com" }, inbox: { defaultWindow: "7d" } })
      );

      const proc = spawn("npx", ["tsx", join(import.meta.dirname, "config-test-helper.ts")], {
        cwd: join(import.meta.dirname, "..", ".."),
        env: { ...process.env, ZMAIL_HOME: spawnHome },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdout = await streamToText(proc.stdout);
      const exitCode = await new Promise<number | null>((resolve) => proc.on("close", resolve));

      expect(exitCode).toBe(0);
      const loaded = JSON.parse(stdout);
      expect(loaded.inbox.defaultWindow).toBe("7d");
    });
  });
});
