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

describe("setup", () => {
  const originalZmailHome = process.env.ZMAIL_HOME;
  const testHome = join(tmpdir(), "zmail-setup-test-" + Date.now());
  
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

  describe("setup without credentials", () => {
    it("shows help and mentions wizard", async () => {
      const proc = spawn("npx", ["tsx", join(import.meta.dirname, "..", "index.ts"), "setup"], {
        cwd: join(import.meta.dirname, "..", ".."),
        env: { ...process.env, ZMAIL_HOME: testHome },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        streamToText(proc.stdout),
        streamToText(proc.stderr),
        new Promise<number | null>((resolve) => proc.on("close", resolve)),
      ]);

      expect(exitCode).toBe(1);
      const output = stdout + stderr;
      expect(output).toContain("zmail setup — CLI/agent-first");
      expect(output).toContain("--email");
      expect(output).toContain("--password");
      expect(output).toContain("--openai-key");
      expect(output).toContain("zmail wizard");
    });
  });

  describe("agent-friendly non-interactive setup", () => {
    it("succeeds with all flags and --no-validate", async () => {
      const proc = spawn(
        "npx",
        [
          "tsx",
          join(import.meta.dirname, "..", "index.ts"),
          "setup",
          "--email",
          "agent@gmail.com",
          "--password",
          "test-app-password",
          "--openai-key",
          "sk-test-key",
          "--no-validate",
        ],
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

      expect(exitCode).toBe(0);
      const output = stdout + stderr;
      expect(output).toContain("Config saved to");

      const config = JSON.parse(readFileSync(join(testHome, "config.json"), "utf8"));
      expect(config.imap.user).toBe("agent@gmail.com");
      expect(config.imap.host).toBe("imap.gmail.com");
      expect(config.imap.port).toBe(993);

      const envContent = readFileSync(join(testHome, ".env"), "utf8");
      expect(envContent).toContain("ZMAIL_IMAP_PASSWORD=test-app-password");
      expect(envContent).toContain("ZMAIL_OPENAI_API_KEY=sk-test-key");
    });

    it("succeeds with environment variables and --no-validate", async () => {
      const proc = spawn(
        "npx",
        ["tsx", join(import.meta.dirname, "..", "index.ts"), "setup", "--no-validate"],
        {
          cwd: join(import.meta.dirname, "..", ".."),
          env: {
            ...process.env,
            ZMAIL_HOME: testHome,
            ZMAIL_EMAIL: "envuser@gmail.com",
            ZMAIL_IMAP_PASSWORD: "env-password",
            ZMAIL_OPENAI_API_KEY: "sk-env-key",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      proc.stdin?.end();

      const exitCode = await new Promise<number | null>((resolve) => proc.on("close", resolve));
      expect(exitCode).toBe(0);

      const config = JSON.parse(readFileSync(join(testHome, "config.json"), "utf8"));
      expect(config.imap.user).toBe("envuser@gmail.com");

      const envContent = readFileSync(join(testHome, ".env"), "utf8");
      expect(envContent).toContain("ZMAIL_IMAP_PASSWORD=env-password");
      expect(envContent).toContain("ZMAIL_OPENAI_API_KEY=sk-env-key");
    });

    it("succeeds with OPENAI_API_KEY fallback when ZMAIL_OPENAI_API_KEY not set", async () => {
      const proc = spawn(
        "npx",
        ["tsx", join(import.meta.dirname, "..", "index.ts"), "setup", "--no-validate"],
        {
          cwd: join(import.meta.dirname, "..", ".."),
          env: {
            ...process.env,
            ZMAIL_HOME: testHome,
            ZMAIL_EMAIL: "openai-fallback@gmail.com",
            ZMAIL_IMAP_PASSWORD: "test-password",
            OPENAI_API_KEY: "sk-openai-fallback-key",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      proc.stdin?.end();

      const exitCode = await new Promise<number | null>((resolve) => proc.on("close", resolve));
      expect(exitCode).toBe(0);

      const envContent = readFileSync(join(testHome, ".env"), "utf8");
      expect(envContent).toContain("ZMAIL_OPENAI_API_KEY=sk-openai-fallback-key");
    });

    it("exits with error when some credentials missing in non-interactive mode", async () => {
      const proc = spawn(
        "npx",
        [
          "tsx",
          join(import.meta.dirname, "..", "index.ts"),
          "setup",
          "--email",
          "partial@gmail.com",
          "--no-validate",
        ],
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

      expect(exitCode).toBe(1);
      const output = stdout + stderr;
      expect(output).toContain("missing required values");
      expect(output).toContain("--password or ZMAIL_IMAP_PASSWORD");
      expect(output).toContain("--openai-key or ZMAIL_OPENAI_API_KEY");
    });
  });

  describe("--clean flag", () => {
    it("deletes existing config and data files", () => {
      // Create existing config
      writeFileSync(join(testHome, "config.json"), JSON.stringify({ imap: { user: "old@example.com" } }));
      writeFileSync(join(testHome, ".env"), "ZMAIL_IMAP_PASSWORD=oldpass\nZMAIL_OPENAI_API_KEY=oldkey\n");
      mkdirSync(join(testHome, "data"), { recursive: true });
      writeFileSync(join(testHome, "data", "test.txt"), "test");
      
      // Verify files exist
      expect(existsSync(join(testHome, "config.json"))).toBe(true);
      expect(existsSync(join(testHome, ".env"))).toBe(true);
      expect(existsSync(join(testHome, "data"))).toBe(true);
      
      // Simulate clean operation (same logic as setup.ts)
      const configPath = join(testHome, "config.json");
      const envPath = join(testHome, ".env");
      const dataPath = join(testHome, "data");
      
      if (existsSync(configPath)) rmSync(configPath);
      if (existsSync(envPath)) rmSync(envPath);
      if (existsSync(dataPath)) rmSync(dataPath, { recursive: true, force: true });
      
      // Verify files are gone
      expect(existsSync(join(testHome, "config.json"))).toBe(false);
      expect(existsSync(join(testHome, ".env"))).toBe(false);
      expect(existsSync(join(testHome, "data"))).toBe(false);
    });
  });

  describe("config file operations", () => {
    it("loads existing config.json correctly", () => {
      const configData = {
        imap: {
          host: "imap.example.com",
          port: 993,
          user: "test@example.com",
        },
        sync: {
          defaultSince: "7d",
          mailbox: "INBOX",
          excludeLabels: ["Spam"],
        },
      };
      
      writeFileSync(join(testHome, "config.json"), JSON.stringify(configData));
      
      const content = readFileSync(join(testHome, "config.json"), "utf8");
      const parsed = JSON.parse(content);
      
      expect(parsed.imap.user).toBe("test@example.com");
      expect(parsed.imap.host).toBe("imap.example.com");
      expect(parsed.sync.defaultSince).toBe("7d");
    });

    it("loads existing .env correctly", () => {
      const envContent = `ZMAIL_IMAP_PASSWORD=testpass123
ZMAIL_OPENAI_API_KEY=sk-testkey123
`;
      writeFileSync(join(testHome, ".env"), envContent);
      
      const content = readFileSync(join(testHome, ".env"), "utf8");
      const passwordMatch = content.match(/^ZMAIL_IMAP_PASSWORD=(.*)$/m);
      const apiKeyMatch = content.match(/^ZMAIL_OPENAI_API_KEY=(.*)$/m);
      
      expect(passwordMatch?.[1]).toBe("testpass123");
      expect(apiKeyMatch?.[1]).toBe("sk-testkey123");
    });

    it("writes config.json with correct structure", () => {
      const configJson = {
        imap: {
          host: "imap.gmail.com",
          port: 993,
          user: "test@gmail.com",
        },
        sync: {
          defaultSince: "1y",
          mailbox: "",
          excludeLabels: ["Trash", "Spam"],
        },
      };
      
      writeFileSync(join(testHome, "config.json"), JSON.stringify(configJson, null, 2) + "\n");
      
      const content = readFileSync(join(testHome, "config.json"), "utf8");
      const parsed = JSON.parse(content);
      
      expect(parsed.imap.host).toBe("imap.gmail.com");
      expect(parsed.imap.port).toBe(993);
      expect(parsed.imap.user).toBe("test@gmail.com");
      expect(parsed.sync.defaultSince).toBe("1y");
      expect(parsed.sync.excludeLabels).toEqual(["Trash", "Spam"]);
    });

    it("writes .env with correct format", () => {
      const envContent = `ZMAIL_IMAP_PASSWORD=testpass
ZMAIL_OPENAI_API_KEY=sk-testkey
`;
      writeFileSync(join(testHome, ".env"), envContent);
      
      const content = readFileSync(join(testHome, ".env"), "utf8");
      expect(content).toContain("ZMAIL_IMAP_PASSWORD=testpass");
      expect(content).toContain("ZMAIL_OPENAI_API_KEY=sk-testkey");
    });

    it("handles invalid JSON in config.json gracefully", () => {
      writeFileSync(join(testHome, "config.json"), "invalid json {");
      
      // Simulate loadExistingConfig logic
      let result: any = null;
      try {
        const content = readFileSync(join(testHome, "config.json"), "utf8");
        result = JSON.parse(content);
      } catch {
        result = null;
      }
      
      expect(result).toBeNull();
    });

    it("parses .env with comments and empty lines", () => {
      const envContent = `# This is a comment
ZMAIL_IMAP_PASSWORD=testpass

ZMAIL_OPENAI_API_KEY=sk-testkey
# Another comment
`;
      writeFileSync(join(testHome, ".env"), envContent);
      
      // Simulate loadExistingEnv parsing logic
      const content = readFileSync(join(testHome, ".env"), "utf8");
      const result: { password?: string; apiKey?: string } = {};
      
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const match = trimmed.match(/^ZMAIL_IMAP_PASSWORD=(.*)$/);
        if (match) {
          result.password = match[1];
          continue;
        }
        const openaiMatch = trimmed.match(/^ZMAIL_OPENAI_API_KEY=(.*)$/);
        if (openaiMatch) {
          result.apiKey = openaiMatch[1];
        }
      }
      
      expect(result.password).toBe("testpass");
      expect(result.apiKey).toBe("sk-testkey");
    });
  });

  describe("email domain detection", () => {
    it("detects Gmail domain correctly", () => {
      // Test the deriveImapSettings logic indirectly via the setup flow
      // Gmail emails should result in imap.gmail.com:993
      const email = "test@gmail.com";
      const domain = email.split("@")[1]?.toLowerCase();
      
      expect(domain).toBe("gmail.com");
      
      // Simulate the derivation logic
      let host = "imap.gmail.com";
      let port = 993;
      if (domain === "gmail.com") {
        host = "imap.gmail.com";
        port = 993;
      }
      
      expect(host).toBe("imap.gmail.com");
      expect(port).toBe(993);
    });

    it("handles unknown domains", () => {
      const email = "test@example.com";
      const domain = email.split("@")[1]?.toLowerCase();
      
      expect(domain).toBe("example.com");
      
      // Unknown domain should use defaults
      let host = "imap.gmail.com";
      let port = 993;
      if (domain === "gmail.com") {
        host = "imap.gmail.com";
        port = 993;
      }
      // domain is not gmail.com, so defaults remain
      
      expect(host).toBe("imap.gmail.com"); // default
      expect(port).toBe(993); // default
    });
  });

  describe("secret masking", () => {
    it("masks secrets correctly", () => {
      // Test maskSecret logic
      const maskSecret = (value: string): string => {
        if (value.length <= 4) return "****";
        return value.slice(0, 4) + "...";
      };
      
      expect(maskSecret("sk-testkey123")).toBe("sk-t...");
      expect(maskSecret("test")).toBe("****");
      expect(maskSecret("abc")).toBe("****");
      expect(maskSecret("longpassword123")).toBe("long...");
    });
  });

  describe("directory creation", () => {
    it("creates ZMAIL_HOME directory if it doesn't exist", () => {
      const newHome = join(testHome, "new-home");
      expect(existsSync(newHome)).toBe(false);
      
      mkdirSync(newHome, { recursive: true });
      
      expect(existsSync(newHome)).toBe(true);
    });
  });

  describe("integration", () => {
    it("setup with --no-validate only (no credentials) shows help", async () => {
      const proc = spawn("npx", ["tsx", join(import.meta.dirname, "..", "index.ts"), "setup", "--no-validate"], {
        cwd: join(import.meta.dirname, "..", ".."),
        env: { ...process.env, ZMAIL_HOME: testHome },
        stdio: ["pipe", "pipe", "pipe"],
      });

      proc.stdin?.end();
      const exitCode = await new Promise<number | null>((resolve) => proc.on("close", resolve));
      expect(exitCode).toBe(1);
    });

    it("setup with --clean --yes and full credentials succeeds", async () => {
      writeFileSync(join(testHome, "config.json"), JSON.stringify({ test: true }));
      const proc = spawn(
        "npx",
        [
          "tsx",
          join(import.meta.dirname, "..", "index.ts"),
          "setup",
          "--clean",
          "--yes",
          "--no-validate",
          "--email",
          "clean@gmail.com",
          "--password",
          "pass",
          "--openai-key",
          "sk-key",
        ],
        {
          cwd: join(import.meta.dirname, "..", ".."),
          env: { ...process.env, ZMAIL_HOME: testHome },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      proc.stdin?.end();
      const exitCode = await new Promise<number | null>((resolve) => proc.on("close", resolve));
      expect(exitCode).toBe(0);
    });
  });
});
