import { mkdirSync, createWriteStream, type WriteStream } from "fs";
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

function logToConsole(level: Level, msg: string, data?: Record<string, unknown>) {
  if (LEVELS[level] < LEVELS[minLevel]) return;

  const ts = new Date().toISOString();
  const prefix = `[${ts}] ${level.toUpperCase().padEnd(5)}`;
  const line = data
    ? `${prefix} ${msg} ${JSON.stringify(data)}`
    : `${prefix} ${msg}`;

  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export interface Logger {
  debug: (msg: string, data?: Record<string, unknown>) => void;
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
}

export interface FileLogger extends Logger {
  logPath: string;
  writeSeparator: (pid: number) => void;
  close: () => void;
}

// Default logger writes to stdout/stderr
const defaultLogger: Logger = {
  debug: (msg: string, data?: Record<string, unknown>) =>
    logToConsole("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) =>
    logToConsole("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) =>
    logToConsole("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) =>
    logToConsole("error", msg, data),
};

// Mutable logger instance - can be replaced for sync/rebuild operations
export let logger: Logger = defaultLogger;

/**
 * Replace the global logger (e.g., with a file logger for sync operations).
 * Returns a function to restore the original logger.
 */
export function setLogger(newLogger: Logger): () => void {
  const original = logger;
  logger = newLogger;
  return () => {
    logger = original;
  };
}

/**
 * Fixed path for sync log file (all sync runs append to this file)
 */
export const SYNC_LOG_PATH = join(ZMAIL_HOME, "logs", "sync.log");

/**
 * Create a file logger that writes to {ZMAIL_HOME}/logs/{filename}.log
 * Ensures the logs directory exists.
 */
export function createFileLogger(filename: string): FileLogger {
  const logsDir = join(ZMAIL_HOME, "logs");
  mkdirSync(logsDir, { recursive: true });

  const logPath = join(logsDir, `${filename}.log`);
  const stream: WriteStream = createWriteStream(logPath, { flags: "a", autoClose: false });

  function write(level: Level, msg: string, data?: Record<string, unknown>) {
    if (LEVELS[level] < LEVELS[minLevel]) return;

    const ts = new Date().toISOString();
    const prefix = `[${ts}] ${level.toUpperCase().padEnd(5)}`;
    const line = data
      ? `${prefix} ${msg} ${JSON.stringify(data)}\n`
      : `${prefix} ${msg}\n`;

    // Write to stream - Node.js will buffer, but we ensure flush on close
    stream.write(line);
  }

  return {
    logPath,
    debug: (msg: string, data?: Record<string, unknown>) => write("debug", msg, data),
    info: (msg: string, data?: Record<string, unknown>) => write("info", msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => write("warn", msg, data),
    error: (msg: string, data?: Record<string, unknown>) => write("error", msg, data),
    writeSeparator: (pid: number) => {
      const ts = new Date().toISOString();
      stream.write(`===== SYNC RUN ${ts} (PID ${pid}) =====\n`);
    },
    close: () => {
      // Ensure all pending writes are flushed before closing
      stream.end(() => {
        // Stream closed callback - all data is now written
      });
    },
  };
}

/**
 * Generate a sync log filename with date and time: sync-YYYYMMDD-HHMMSS (UTC)
 * @deprecated Use SYNC_LOG_PATH constant instead. Kept for backward compatibility.
 */
export function generateSyncLogFilename(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  return `sync-${date}-${time}`;
}
