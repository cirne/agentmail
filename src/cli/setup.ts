import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { ImapFlow } from "imapflow";
import OpenAI from "openai";
import { ZMAIL_HOME } from "~/lib/config";

interface SetupConfig {
  imap: {
    host: string;
    port: number;
    user: string;
    password: string;
  };
  openai: {
    apiKey: string;
  };
  sync: {
    defaultSince: string;
  };
}

/** Derive IMAP host/port from email domain. Returns null if unknown. */
export function deriveImapSettings(email: string): { host: string; port: number } | null {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return null;
  
  if (domain === "gmail.com") {
    return { host: "imap.gmail.com", port: 993 };
  }
  // Add more providers as needed
  return null;
}

/** Validate IMAP credentials by attempting connection. */
export async function validateImap(config: { host: string; port: number; user: string; password: string }): Promise<boolean> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.port === 993,
    auth: { user: config.user, pass: config.password },
    logger: false,
    connectionTimeout: 10000,
  });
  
  try {
    await client.connect();
    await client.logout();
    return true;
  } catch {
    return false;
  }
}

/** Validate OpenAI API key by making a test call. */
export async function validateOpenAI(apiKey: string): Promise<boolean> {
  try {
    const client = new OpenAI({ apiKey });
    await client.models.list();
    return true;
  } catch {
    return false;
  }
}

/** Load existing config.json if it exists. */
export function loadExistingConfig(): Partial<SetupConfig> | null {
  const configPath = join(ZMAIL_HOME, "config.json");
  if (!existsSync(configPath)) return null;
  
  try {
    const content = readFileSync(configPath, "utf8");
    const json = JSON.parse(content);
    return {
      imap: json.imap || {},
      sync: json.sync || {},
    } as Partial<SetupConfig>;
  } catch {
    return null;
  }
}

/** Load existing .env if it exists. */
export function loadExistingEnv(): { password?: string; apiKey?: string } {
  const envPath = join(ZMAIL_HOME, ".env");
  if (!existsSync(envPath)) return {};
  
  const content = readFileSync(envPath, "utf8");
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
  
  return result;
}

/** Mask secret value for display. */
export function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  return value.slice(0, 4) + "...";
}

export interface SetupOptions {
  /** Email address (Gmail). Provided via --email or ZMAIL_EMAIL. */
  email?: string;
  /** IMAP app password. Provided via --password or ZMAIL_IMAP_PASSWORD. */
  password?: string;
  /** OpenAI API key. Provided via --openai-key or ZMAIL_OPENAI_API_KEY. */
  openaiKey?: string;
  /** Sync default duration (e.g. 7d, 1y). Default: 1y. */
  defaultSince?: string;
  /** Skip credential validation. */
  noValidate?: boolean;
  /** Delete existing config and data before setup. */
  clean?: boolean;
  /** Skip confirmation prompts (required for --clean in non-interactive mode). */
  yes?: boolean;
}

/** Run non-interactive setup when all required values are provided. Never prompts. */
async function executeNonInteractiveSetup(opts: Required<Pick<SetupOptions, "email" | "password" | "openaiKey">> & SetupOptions): Promise<void> {
  const { email, password, openaiKey, noValidate = false, clean = false, yes = false, defaultSince = "1y" } = opts;

  if (clean) {
    if (!yes) {
      console.error("zmail setup: --clean requires --yes in non-interactive mode.");
      process.exit(1);
    }
    const configPath = join(ZMAIL_HOME, "config.json");
    const envPath = join(ZMAIL_HOME, ".env");
    const dataPath = join(ZMAIL_HOME, "data");
    const hasExisting = existsSync(configPath) || existsSync(envPath) || existsSync(dataPath);
    if (hasExisting) {
      if (existsSync(configPath)) rmSync(configPath);
      if (existsSync(envPath)) rmSync(envPath);
      if (existsSync(dataPath)) rmSync(dataPath, { recursive: true, force: true });
    }
  }

  mkdirSync(ZMAIL_HOME, { recursive: true });

  const derived = deriveImapSettings(email);
  const host = derived?.host ?? "imap.gmail.com";
  const port = derived?.port ?? 993;

  if (!noValidate) {
    process.stdout.write("Validating IMAP... ");
    const imapValid = await validateImap({ host, port, user: email, password });
    if (!imapValid) {
      console.error("Failed");
      console.error("Could not connect to IMAP. Check your credentials.");
      process.exit(1);
    }
    console.log("OK");
  }

  if (!noValidate) {
    process.stdout.write("Validating OpenAI API key... ");
    const openaiValid = await validateOpenAI(openaiKey);
    if (!openaiValid) {
      console.error("Failed");
      console.error("Invalid OpenAI API key.");
      process.exit(1);
    }
    console.log("OK");
  }

  const configJson = {
    imap: { host, port, user: email },
    sync: {
      defaultSince,
      mailbox: "",
      excludeLabels: ["Trash", "Spam"],
    },
  };
  writeFileSync(join(ZMAIL_HOME, "config.json"), JSON.stringify(configJson, null, 2) + "\n");
  const envContent = `ZMAIL_IMAP_PASSWORD=${password}
ZMAIL_OPENAI_API_KEY=${openaiKey}
`;
  writeFileSync(join(ZMAIL_HOME, ".env"), envContent);
  console.log(`Config saved to ${ZMAIL_HOME}/`);
}

function printSetupHelp(): void {
  console.error("zmail setup — CLI/agent-first. Provide credentials via flags or env.");
  console.error("");
  console.error("  zmail setup --email <email> --password <app-password> --openai-key <key> [--no-validate]");
  console.error("  ZMAIL_EMAIL=... ZMAIL_IMAP_PASSWORD=... ZMAIL_OPENAI_API_KEY=... zmail setup");
  console.error("");
  console.error("For interactive prompts, use: zmail wizard");
  console.error("");
  process.exit(1);
}

export async function runSetup(options: SetupOptions | boolean = {}): Promise<void> {
  const opts: SetupOptions = typeof options === "boolean" ? { noValidate: options } : options;

  const email = opts.email?.trim() || process.env.ZMAIL_EMAIL?.trim();
  const password = opts.password || process.env.ZMAIL_IMAP_PASSWORD;
  const openaiKey = opts.openaiKey || process.env.ZMAIL_OPENAI_API_KEY || process.env.OPENAI_API_KEY;

  const hasAllRequired = Boolean(email && password && openaiKey);
  const hasSome = Boolean(email || password || openaiKey);

  if (hasAllRequired) {
    await executeNonInteractiveSetup({
      ...opts,
      email: email!,
      password: password!,
      openaiKey: openaiKey!,
      defaultSince: opts.defaultSince || "1y",
    });
    return;
  }

  if (hasSome) {
    const missing: string[] = [];
    if (!email) missing.push("--email or ZMAIL_EMAIL");
    if (!password) missing.push("--password or ZMAIL_IMAP_PASSWORD");
    if (!openaiKey) missing.push("--openai-key or ZMAIL_OPENAI_API_KEY (in .env)");
    console.error(`zmail setup: missing required values: ${missing.join(", ")}`);
    console.error("Provide all credentials via flags or environment variables.");
    process.exit(1);
  }

  printSetupHelp();
}
