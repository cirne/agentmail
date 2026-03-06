import { mkdirSync, createWriteStream, WriteStream } from "fs";
import { join } from "path";
import { ZMAIL_HOME } from "./config";

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const minLevel: Level =
  (process.env.LOG_LEVEL as Level | undefined) ?? "info";

export interface FileLogger {
  logPath: string;
  debug: (msg: string, data?: Record<string, unknown>) => void;
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
  close: () => void;
}

/**
 * Create a file logger that writes to {ZMAIL_HOME}/logs/{filename}.log
 * Ensures the logs directory exists.
 */
export function createFileLogger(filename: string): FileLogger {
  const logsDir = join(ZMAIL_HOME, "logs");
  mkdirSync(logsDir, { recursive: true });

  const logPath = join(logsDir, `${filename}.log`);
  const stream: WriteStream = createWriteStream(logPath, { flags: "a" });

  function write(level: Level, msg: string, data?: Record<string, unknown>) {
    if (LEVELS[level] < LEVELS[minLevel]) return;

    const ts = new Date().toISOString();
    const prefix = `[${ts}] ${level.toUpperCase().padEnd(5)}`;
    const line = data
      ? `${prefix} ${msg} ${JSON.stringify(data)}\n`
      : `${prefix} ${msg}\n`;

    stream.write(line);
  }

  return {
    logPath,
    debug: (msg: string, data?: Record<string, unknown>) => write("debug", msg, data),
    info: (msg: string, data?: Record<string, unknown>) => write("info", msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => write("warn", msg, data),
    error: (msg: string, data?: Record<string, unknown>) => write("error", msg, data),
    close: () => {
      stream.end();
    },
  };
}

/**
 * Generate a sync log filename with date and time: sync-YYYYMMDD-HHMMSS (UTC)
 */
export function generateSyncLogFilename(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  return `sync-${date}-${time}`;
}
