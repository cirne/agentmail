import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync } from "fs";
import { resolveSmtpSettings } from "~/send/smtp-resolve";

/** Canonical app root: ~/.zmail (cross-platform via os.homedir()). Can be overridden via ZMAIL_HOME env var. */
export function getZmailHome(): string {
  return process.env.ZMAIL_HOME || join(homedir(), ".zmail");
}

/** Resolved at module load; use getZmailHome() when ZMAIL_HOME may change (e.g. in tests). */
export const ZMAIL_HOME = getZmailHome();

interface ConfigJson {
  imap?: {
    host?: string;
    port?: number;
    user?: string;
  };
  /** Optional SMTP submission overrides. When omitted, inferred from IMAP host (see resolveSmtpSettings). */
  smtp?: {
    host?: string;
    port?: number;
    /** true = implicit TLS (e.g. 465); false = STARTTLS (e.g. 587) */
    secure?: boolean;
  };
  sync?: {
    defaultSince?: string;
    mailbox?: string;
    excludeLabels?: string[];
  };
  /** When true, use cached extracted_text for attachment read (faster repeat reads). Default false = always re-extract. */
  attachments?: {
    cacheExtractedText?: boolean;
  };
  /** Defaults for `zmail inbox` (LLM scan). */
  inbox?: {
    /** Rolling window when CLI does not pass a window (default in code: 24h). */
    defaultWindow?: string;
  };
}

interface ConfigEnv {
  ZMAIL_EMAIL?: string;
  ZMAIL_IMAP_PASSWORD?: string;
  ZMAIL_OPENAI_API_KEY?: string;
  OPENAI_API_KEY?: string;
}

/**
 * Load .env file from specified home directory.
 * Returns parsed environment variables without mutating process.env.
 * This allows explicit control over env loading in tests.
 */
export function loadEnvFile(home: string): ConfigEnv {
  const envPath = join(home, ".env");
  if (!existsSync(envPath)) return {};
  
  const result: ConfigEnv = {};
  const content = readFileSync(envPath, "utf8");
  
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) {
      const [, key, value] = match;
      // Only include keys we care about
      if (key === "ZMAIL_EMAIL" || key === "ZMAIL_IMAP_PASSWORD" || key === "ZMAIL_OPENAI_API_KEY" || key === "OPENAI_API_KEY") {
        result[key as keyof ConfigEnv] = value;
      }
    }
  }
  
  return result;
}

/**
 * Load config.json from specified home directory.
 * Returns empty object if missing or invalid.
 */
export function loadConfigJson(home: string): ConfigJson {
  const configPath = join(home, "config.json");
  if (!existsSync(configPath)) return {};
  
  try {
    const content = readFileSync(configPath, "utf8");
    return JSON.parse(content) as ConfigJson;
  } catch {
    return {};
  }
}

/**
 * Load configuration from specified home directory and environment.
 * This is a pure function that doesn't mutate global state.
 */
export function loadConfig(options?: { home?: string; env?: NodeJS.ProcessEnv }): {
  imap: {
    host: string;
    port: number;
    user: string;
    password: string;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
  };
  sync: {
    defaultSince: string;
    mailbox: string;
    excludeLabels: string[];
  };
  attachments: {
    cacheExtractedText: boolean;
  };
  inbox: {
    defaultWindow: string;
  };
  openai: {
    apiKey: string;
  };
  dataDir: string;
  dbPath: string;
  maildirPath: string;
} {
  const home = options?.home ?? getZmailHome();
  const env = options?.env ?? process.env;
  const envFile = loadEnvFile(home);
  const configJson = loadConfigJson(home);
  
  // Merge env file with process env (process env takes precedence)
  const effectiveEnv = { ...envFile, ...env };
  
  function optionalZmail(key: string, fallback: string): string {
    return effectiveEnv[key as keyof typeof effectiveEnv] ?? fallback;
  }
  
  function getOpenAIKey(): string {
    const key = effectiveEnv.ZMAIL_OPENAI_API_KEY || effectiveEnv.OPENAI_API_KEY;
    if (key) return key;
    throw new Error("Missing required environment variable: ZMAIL_OPENAI_API_KEY or OPENAI_API_KEY");
  }
  
  const dataDir = join(home, "data");

  const imapHost = configJson.imap?.host ?? "imap.gmail.com";
  const smtpOverrides = configJson.smtp ?? undefined;
  const smtpResolved = resolveSmtpSettings(imapHost, smtpOverrides);

  return {
    imap: {
      host: imapHost,
      port: configJson.imap?.port ?? 993,
      user: configJson.imap?.user ?? optionalZmail("ZMAIL_EMAIL", ""),
      password: optionalZmail("ZMAIL_IMAP_PASSWORD", ""),
    },
    smtp: smtpResolved,
    sync: {
      defaultSince: configJson.sync?.defaultSince ?? "1y",
      mailbox: configJson.sync?.mailbox ?? "",
      excludeLabels: configJson.sync?.excludeLabels ?? ["trash", "spam"],
    },
    attachments: {
      cacheExtractedText: configJson.attachments?.cacheExtractedText ?? false,
    },
    inbox: {
      defaultWindow: configJson.inbox?.defaultWindow ?? "24h",
    },
    get openai() {
      return { apiKey: getOpenAIKey() };
    },
    get dataDir() {
      return dataDir;
    },
    get dbPath() {
      return join(this.dataDir, "zmail.db");
    },
    get maildirPath() {
      return join(this.dataDir, "maildir");
    },
  } as any; // Type assertion needed because getters can't be in object literals
}

// Legacy: Load .env into process.env at module load time for backward compatibility
// This maintains existing behavior while new code can use loadConfig()
const envFile = loadEnvFile(getZmailHome());
for (const [key, value] of Object.entries(envFile)) {
  if (!(key in process.env)) {
    process.env[key] = value;
  }
}

// Legacy config export: uses loadConfig() internally for consistency
// This maintains backward compatibility while new code can use loadConfig() directly
// Note: Config is loaded fresh on each access to handle env var changes in tests
// For production use, consider using loadConfig() directly with explicit caching if needed
export const config = {
  get imap() {
    return loadConfig().imap;
  },
  get smtp() {
    return loadConfig().smtp;
  },
  get sync() {
    return loadConfig().sync;
  },
  get attachments() {
    return loadConfig().attachments;
  },
  get inbox() {
    return loadConfig().inbox;
  },
  get openai() {
    return loadConfig().openai;
  },
  get dataDir() {
    return loadConfig().dataDir;
  },
  get dbPath() {
    return loadConfig().dbPath;
  },
  get maildirPath() {
    return loadConfig().maildirPath;
  },
} as const;

export function requireImapConfig() {
  if (!config.imap.user) {
    throw new Error("Missing required config: imap.user (set in ~/.zmail/config.json or run 'zmail setup')");
  }
  if (!config.imap.password) {
    throw new Error("Missing required config: imap.password (set in ~/.zmail/.env as ZMAIL_IMAP_PASSWORD or run 'zmail setup')");
  }
  return config.imap;
}

/** Check if config.json exists. Used to determine if setup has been run. */
export function hasConfig(): boolean {
  const home = process.env.ZMAIL_HOME || join(homedir(), ".zmail");
  return existsSync(join(home, "config.json"));
}
