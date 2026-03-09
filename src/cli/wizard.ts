/**
 * Interactive setup wizard. For CLI/agent setup, use `zmail setup` with flags.
 */
import { spawn } from "child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { input, password, select, confirm } from "@inquirer/prompts";
import { ZMAIL_HOME } from "~/lib/config";
import {
  deriveImapSettings,
  validateImap,
  validateOpenAI,
  loadExistingConfig,
  loadExistingEnv,
  maskSecret,
} from "./setup";

const SYNC_DURATION_CHOICES = [
  { value: "7d", name: "7 days", description: "Quick start, recent email only" },
  { value: "5w", name: "5 weeks" },
  { value: "3m", name: "3 months" },
  { value: "1y", name: "1 year (recommended)", description: "Good balance of history and sync time" },
  { value: "2y", name: "2 years" },
] as const;

export async function runWizard(options: { noValidate?: boolean; clean?: boolean; yes?: boolean } = {}): Promise<void> {
  // BUG-009 fix: Check for non-TTY stdin before launching interactive prompts
  if (!process.stdin.isTTY) {
    console.error("Wizard requires an interactive terminal. Use 'zmail setup' instead.");
    process.exit(1);
  }

  const { noValidate = false, clean = false, yes = false } = options;

  if (clean) {
    const configPath = join(ZMAIL_HOME, "config.json");
    const envPath = join(ZMAIL_HOME, ".env");
    const dataPath = join(ZMAIL_HOME, "data");
    const hasExisting = existsSync(configPath) || existsSync(envPath) || existsSync(dataPath);

    if (hasExisting) {
      if (!yes) {
        const proceed = await confirm({
          message: "This will delete all existing config and data. Continue?",
          default: false,
        });
        if (!proceed) {
          console.log("Cancelled.");
          process.exit(0);
        }
      }
      if (existsSync(configPath)) rmSync(configPath);
      if (existsSync(envPath)) rmSync(envPath);
      if (existsSync(dataPath)) rmSync(dataPath, { recursive: true, force: true });
      console.log("Done.\n");
    }
  }

  mkdirSync(ZMAIL_HOME, { recursive: true });
  const existingConfig = loadExistingConfig();
  const existingEnv = loadExistingEnv();
  const isFirstRun = !existingConfig && !existingEnv.password;

  if (isFirstRun) {
    console.log("\nzmail wizard — let's get you connected.\n");
  } else {
    console.log("\nzmail wizard — updating existing config.\n");
  }

  const emailDefault = existingConfig?.imap?.user || "";
  const email = await input({
    message: "Email address",
    default: emailDefault,
    required: true,
    validate: (v) => (v.trim() ? true : "Email address is required"),
  });
  if (!email.trim()) {
    console.error("Email address is required.");
    process.exit(1);
  }

  const derived = deriveImapSettings(email);
  const hostDefault = existingConfig?.imap?.host || derived?.host || "imap.gmail.com";
  const portDefault = existingConfig?.imap?.port ?? derived?.port ?? 993;

  if (derived) {
    console.log(`  → ${derived.host === "imap.gmail.com" ? "Gmail" : "Provider"} detected (${derived.host}:${derived.port})`);
  }

  let host = hostDefault;
  let port = portDefault;
  if (!derived) {
    host = await input({
      message: "IMAP host",
      default: hostDefault,
    });
    const portStr = await input({
      message: "IMAP port",
      default: String(portDefault),
    });
    port = parseInt(portStr, 10) || portDefault;
  }

  let passwordValue: string;
  if (existingEnv.password) {
    const useExisting = await confirm({
      message: `Use existing IMAP password (${maskSecret(existingEnv.password)})?`,
      default: true,
    });
    passwordValue = useExisting ? existingEnv.password : await password({
      message: "IMAP app password",
      mask: true,
      validate: (v) => (v ? true : "IMAP password is required"),
    });
  } else {
    console.log("Gmail requires an app password (not your regular password).");
    console.log("An app password is a 16-character code that lets IMAP clients like zmail access your mail without your main password.");
    console.log("Enable 2-Step Verification first if you don't have it: https://myaccount.google.com/signinoptions/two-step-verification");
    console.log("Then create an app password: https://myaccount.google.com/apppasswords");
    passwordValue = await password({
      message: "IMAP app password",
      mask: true,
      validate: (v) => (v ? true : "IMAP password is required"),
    });
  }

  if (!noValidate) {
    process.stdout.write("  Connecting... ");
    const imapValid = await validateImap({ host, port, user: email, password: passwordValue });
    if (!imapValid) {
      console.log("Failed");
      console.error("  Could not connect. Check your credentials and try again.");
      process.exit(1);
    }
    console.log(`Connected to ${host} as ${email}`);
  }

  let apiKey: string;
  if (existingEnv.apiKey) {
    const useExisting = await confirm({
      message: `Use existing OpenAI API key (${maskSecret(existingEnv.apiKey)})?`,
      default: true,
    });
    apiKey = useExisting ? existingEnv.apiKey : await password({
      message: "OpenAI API key",
      mask: true,
      validate: (v) => (v ? true : "OpenAI API key is required"),
    });
  } else {
    console.log("Get one at https://platform.openai.com/api-keys");
    apiKey = await password({
      message: "OpenAI API key",
      mask: true,
      validate: (v) => (v ? true : "OpenAI API key is required"),
    });
  }

  if (!noValidate) {
    process.stdout.write("  Validating... ");
    const openaiValid = await validateOpenAI(apiKey);
    if (!openaiValid) {
      console.log("Failed");
      console.error("  Invalid API key. Check your key and try again.");
      process.exit(1);
    }
    console.log("API key valid");
  }

  const defaultSince = existingConfig?.sync?.defaultSince || "1y";
  type SyncChoice = (typeof SYNC_DURATION_CHOICES)[number]["value"];
  const validDefaults: SyncChoice[] = ["7d", "5w", "3m", "1y", "2y"];
  const since = await select<SyncChoice>({
    message: "Sync default duration",
    choices: [...SYNC_DURATION_CHOICES],
    default: validDefaults.includes(defaultSince as SyncChoice) ? (defaultSince as SyncChoice) : "1y",
  });

  const configJson = {
    imap: { host, port, user: email },
    sync: {
      defaultSince: since,
      mailbox: "",
      excludeLabels: ["Trash", "Spam"],
    },
  };
  writeFileSync(join(ZMAIL_HOME, "config.json"), JSON.stringify(configJson, null, 2) + "\n");
  writeFileSync(
    join(ZMAIL_HOME, ".env"),
    `ZMAIL_IMAP_PASSWORD=${passwordValue}\nZMAIL_OPENAI_API_KEY=${apiKey}\n`,
  );
  console.log(`\nConfig saved to ${ZMAIL_HOME}/`);

  const shouldStartSync = await confirm({
    message: "Start syncing email now?",
    default: true,
  });

  if (shouldStartSync) {
    console.log(`\nStarting sync in background (--since ${since})...`);
    const entrypointScript = join(import.meta.dirname, "..", "index.ts");
    const proc = spawn("npx", ["tsx", entrypointScript, "sync", "--since", since], {
      cwd: process.cwd(),
      env: { ...process.env, ZMAIL_HOME: process.env.ZMAIL_HOME || ZMAIL_HOME },
      stdio: "pipe",
      detached: true,
    });
    proc.unref();
    console.log("Sync started in background. Use 'zmail status' to check progress.");
  } else {
    console.log("Run `zmail sync --since 7d` to start initial sync, then `zmail refresh` for frequent updates.");
  }
  console.log("");
}
