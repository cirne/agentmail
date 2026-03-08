import { searchWithMeta } from "~/search";
import { who } from "~/search/who";
import { runSync } from "~/sync";
import { getDb, checkSchemaVersion } from "~/db";
import { reindexFromMaildir } from "~/db/rebuild";
import { startMcpServer } from "~/mcp";
import { config } from "~/lib/config";
import { logger, setLogger, SYNC_LOG_PATH, createFileLogger } from "~/lib/logger";
import { parseSinceToDate } from "~/sync/parse-since";
import type { SearchResult, WhoResult } from "~/lib/types";
import type { SqliteDatabase } from "~/db";
import { readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { formatMessageForOutput, formatMessageLlmFriendly } from "~/messages/presenter";
import { extractAndCache } from "~/attachments";
import { getStatus, getImapServerStatus, formatTimeAgo } from "~/lib/status";
import { spawn } from "child_process";
import { isProcessAlive } from "~/lib/process-lock";

/**
 * Check sync log for errors from the most recent sync run.
 * Returns error info if found, otherwise null.
 */
function checkSyncLogForErrors(): { hasError: boolean; errorMessage?: string } {
  if (!existsSync(SYNC_LOG_PATH)) return { hasError: false };
  
  const logContent = readFileSync(SYNC_LOG_PATH, "utf-8");
  // Check for error entries from the most recent run (after last separator)
  const runs = logContent.split(/===== SYNC RUN/);
  const lastRun = runs[runs.length - 1];
  // Log format: [timestamp] ERROR message {...}
  // Check for ERROR level log entries
  const hasError = /ERROR\s+/.test(lastRun) && (
    lastRun.includes('IMAP connection failed') || 
    lastRun.includes('Sync failed')
  );
  if (hasError) {
    // Extract error message from log - try multiple patterns
    let errorMessage = "Sync failed (check log for details)";
    // Pattern: ERROR IMAP connection failed {"...", "errorMessage": "..."}
    const errorMatch = lastRun.match(/IMAP connection failed[^{]*"errorMessage":\s*"([^"]+)"/);
    if (errorMatch) {
      errorMessage = errorMatch[1];
    } else {
      // Pattern: ERROR Sync failed {"...", "error": "..."}
      const syncFailedMatch = lastRun.match(/Sync failed[^{]*"error":\s*"([^"]+)"/);
      if (syncFailedMatch) {
        errorMessage = syncFailedMatch[1];
      } else {
        // Fallback: extract any error message from the JSON
        const anyErrorMatch = lastRun.match(/"error(Message)?":\s*"([^"]+)"/);
        if (anyErrorMatch) {
          errorMessage = anyErrorMatch[2];
        }
      }
    }
    return { hasError: true, errorMessage };
  }
  return { hasError: false };
}

// When invoked as "tsx index.ts -- <cmd>", argv[2] is "--" and argv[3] is the command
const rest = process.argv.slice(2);
const command = rest[0] === "--" ? rest[1] : rest[0];
const args = rest[0] === "--" ? rest.slice(2) : rest.slice(1);

type SearchDetail = "headers" | "snippet" | "body";
type SearchField =
  | "messageId"
  | "threadId"
  | "date"
  | "fromAddress"
  | "fromName"
  | "subject"
  | "rank"
  | "snippet"
  | "bodyPreview"
  | "body"
  | "attachments";

const VALID_DETAILS = new Set<SearchDetail>(["headers", "snippet", "body"]);
const VALID_FIELDS = new Set<SearchField>([
  "messageId",
  "threadId",
  "date",
  "fromAddress",
  "fromName",
  "subject",
  "rank",
  "snippet",
  "bodyPreview",
  "body",
  "attachments",
]);
const DEFAULT_HEADER_FIELDS: SearchField[] = [
  "messageId",
  "threadId",
  "date",
  "fromAddress",
  "fromName",
  "subject",
  "rank",
  "bodyPreview",
  "attachments",
];
const JSON_LIMIT_CAP = 100;
const JSON_BYTE_CAP = 64 * 1024;

/** Normalize message_id/thread_id for DB lookup: stored format includes angle brackets; accept with or without. */
function normalizeMessageId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return id;
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed;
  return `<${trimmed}>`;
}

interface ParsedSearchArgs {
  query: string;
  fromAddress?: string;
  afterDate?: string;
  beforeDate?: string;
  limit?: number;
  detail: SearchDetail;
  fields?: SearchField[];
  forceText: boolean;
  idsOnly: boolean;
  timings: boolean;
  includeTopBody: boolean;
  threads: boolean;
}

function searchUsage() {
  console.error("Usage: zmail search <query> [flags]");
  console.error("");
  console.error("Query can use inline operators: from:, to:, subject:, after:, before:");
  console.error("  Example: zmail search \"from:alice@example.com invoice OR receipt\"");
  console.error("  Example: zmail search \"after:7d subject:meeting\"");
  console.error("");
  console.error("Flags:");
  console.error("  --limit <n>        max results (default: 50)");
  console.error("  --detail <level>   headers | snippet | body (default: headers)");
  console.error("  --fields <csv>     projection fields, e.g. messageId,subject,date");
  console.error("  --threads          return full threads for each match (conversation view)");
  console.error("  --ids-only         return only message IDs");
  console.error("  --timings          include machine-readable search timings");
  console.error("  --text             human-readable table output (default: JSON)");
  console.error("  --no-body          suppress body text for top result (default: included)");
}

interface ParsedWhoArgs {
  query: string;
  limit?: number;
  minSent?: number;
  minReceived?: number;
  includeNoreply?: boolean;
  dynamic?: boolean; // Kept for backward compatibility / testing, but dynamic is now default
  forceText: boolean;
  enrich?: boolean;
}

function whoUsage() {
  console.error("Usage: zmail who <query> [flags]");
  console.error("  --text             human-readable table output (default: JSON)");
  console.error("  --limit <n>        max results (default: 50)");
  console.error("  --min-sent <n>     minimum sent count");
  console.error("  --min-received <n> minimum received count");
  console.error("  --all              include noreply/bot addresses");
  console.error("  --enrich          use LLM (GPT-4.1 nano) to guess names from email addresses");
  console.error("                     requires ZMAIL_OPENAI_API_KEY to be set");
  console.error("");
  console.error("Note: Profiles are built dynamically from messages (always up-to-date)");
}

function parseWhoArgs(rawArgs: string[]): ParsedWhoArgs {
  const parsed: ParsedWhoArgs = {
    query: "",
    forceText: false,
  };

  const queryParts: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    const next = rawArgs[i + 1];
    const readValue = (flag: string): string => {
      if (!next || next.startsWith("-")) {
        throw new Error(`Missing value for ${flag}`);
      }
      i++;
      return next;
    };

    if (arg === "--help") {
      whoUsage();
      process.exit(0);
    }
    if (arg === "--text") {
      parsed.forceText = true;
      continue;
    }
    if (arg === "--all") {
      parsed.includeNoreply = true;
      continue;
    }
    if (arg === "--dynamic") {
      parsed.dynamic = true;
      continue;
    }
    if (arg === "--enrich") {
      parsed.enrich = true;
      continue;
    }
    if (arg === "--limit") {
      const rawLimit = readValue(arg);
      const limit = Number.parseInt(rawLimit, 10);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error(`Invalid --limit: "${rawLimit}". Must be a positive number.`);
      }
      parsed.limit = limit;
      continue;
    }
    if (arg === "--min-sent") {
      const raw = readValue(arg);
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`Invalid --min-sent: "${raw}". Must be a non-negative number.`);
      }
      parsed.minSent = n;
      continue;
    }
    if (arg === "--min-received") {
      const raw = readValue(arg);
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`Invalid --min-received: "${raw}". Must be a non-negative number.`);
      }
      parsed.minReceived = n;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    queryParts.push(arg);
  }

  parsed.query = queryParts.join(" ").trim();
  if (!parsed.query) {
    throw new Error("Provide a query (e.g. zmail who tom).");
  }

  return parsed;
}

function parseDateFlag(raw: string, flagName: "--after" | "--before"): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }
  try {
    return parseSinceToDate(raw);
  } catch {
    throw new Error(
      `Invalid ${flagName} date: "${raw}". Use ISO date (YYYY-MM-DD) or relative (7d, 2w, 1m).`
    );
  }
}

function parseSearchArgs(rawArgs: string[]): ParsedSearchArgs {
  const parsed: ParsedSearchArgs = {
    query: "",
    detail: "headers",
    forceText: false,
    idsOnly: false,
    timings: false,
    includeTopBody: true,
    threads: false,
  };

  const queryParts: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    const next = rawArgs[i + 1];
    const readValue = (flag: string): string => {
      if (!next || next.startsWith("-")) {
        throw new Error(`Missing value for ${flag}`);
      }
      i++;
      return next;
    };

    if (arg === "--help") {
      searchUsage();
      process.exit(0);
    }
    if (arg === "--text") {
      parsed.forceText = true;
      continue;
    }
    if (arg === "--ids-only") {
      parsed.idsOnly = true;
      continue;
    }
    if (arg === "--timings") {
      parsed.timings = true;
      continue;
    }
    if (arg === "--no-body") {
      parsed.includeTopBody = false;
      continue;
    }
    if (arg === "--from") {
      parsed.fromAddress = readValue(arg);
      continue;
    }
    if (arg === "--after") {
      parsed.afterDate = parseDateFlag(readValue(arg), "--after");
      continue;
    }
    if (arg === "--before") {
      parsed.beforeDate = parseDateFlag(readValue(arg), "--before");
      continue;
    }
    if (arg === "--limit") {
      const rawLimit = readValue(arg);
      const limit = Number.parseInt(rawLimit, 10);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error(`Invalid --limit: "${rawLimit}". Must be a positive number.`);
      }
      parsed.limit = limit;
      continue;
    }
    if (arg === "--threads") {
      parsed.threads = true;
      continue;
    }
    if (arg === "--mode") {
      throw new Error(`--mode flag has been removed.`);
    }
    if (arg === "--detail") {
      const detail = readValue(arg) as SearchDetail;
      if (!VALID_DETAILS.has(detail)) {
        throw new Error(`Invalid --detail: "${detail}". Use headers, snippet, or body.`);
      }
      parsed.detail = detail;
      continue;
    }
    if (arg === "--fields") {
      const fieldsRaw = readValue(arg);
      const fields = fieldsRaw
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean) as SearchField[];
      if (fields.length === 0) {
        throw new Error("--fields must include at least one field.");
      }
      for (const field of fields) {
        if (!VALID_FIELDS.has(field)) {
          throw new Error(`Invalid field in --fields: "${field}".`);
        }
      }
      parsed.fields = fields;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    queryParts.push(arg);
  }

  parsed.query = queryParts.join(" ").trim();
  // Query can be empty if filters are provided via inline operators (from:, after:, etc.)
  // The search layer will parse inline operators from the query string
  if (!parsed.query && !parsed.fromAddress && !parsed.afterDate && !parsed.beforeDate) {
    throw new Error("Provide a query (e.g. zmail search \"from:alice@example.com invoice\").");
  }

  return parsed;
}

function resolveDetail(detail: SearchDetail, fields?: SearchField[]): SearchDetail {
  if (fields?.includes("body")) return "body";
  if (fields?.includes("snippet") && detail === "headers") return "snippet";
  return detail;
}

function defaultFieldsForDetail(detail: SearchDetail): SearchField[] {
  if (detail === "body") return [...DEFAULT_HEADER_FIELDS, "snippet", "body"];
  if (detail === "snippet") return [...DEFAULT_HEADER_FIELDS, "snippet"];
  return DEFAULT_HEADER_FIELDS;
}

function hydrateBodies(db: SqliteDatabase, results: SearchResult[]): Array<SearchResult & { body: string }> {
  if (results.length === 0) return [];
  const ids = results.map((r) => r.messageId);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT message_id AS messageId, body_text AS body FROM messages WHERE message_id IN (${placeholders})`
    )
    .all(...ids) as Array<{ messageId: string; body: string }>;
  const bodyByMessageId = new Map(rows.map((row) => [row.messageId, row.body]));
  return results.map((result) => ({
    ...result,
    body: bodyByMessageId.get(result.messageId) ?? "",
  }));
}

function projectResult(
  row: SearchResult & { body?: string },
  detail: SearchDetail,
  fields?: SearchField[]
): Record<string, unknown> {
  const selected = new Set<SearchField>(fields?.length ? fields : defaultFieldsForDetail(detail));
  // Preserve stable IDs for shortlist -> hydrate workflows.
  selected.add("messageId");
  selected.add("threadId");

  const projected: Record<string, unknown> = {};
  for (const field of selected) {
    const value = row[field];
    if (value !== undefined) {
      projected[field] = value;
    }
  }
  return projected;
}

function getSearchHint(
  query: string,
  resultCount: number,
  totalMatched: number,
  limit?: number
): string | undefined {
  const words = query.trim().split(/\s+/).filter(Boolean);
  const isSingleWord = words.length === 1;
  const isVagueWord = isSingleWord && ["important", "urgent", "meeting", "email", "message", "document", "file"].includes(words[0].toLowerCase());

  // No results hint
  if (resultCount === 0) {
    return "No results found. Try broader terms or check spelling.";
  }

  // Batch reading hint (when multiple results found)
  if (resultCount > 1) {
    return `Tip: Top result includes body preview. Use get_messages(messageIds) to batch-read; use detail: 'summary' for minimal tokens when scanning, or detail: 'full' with maxBodyChars as needed.`;
  }

  // Truncated results hint (only show if we have more results than displayed)
  if (totalMatched > resultCount && totalMatched > (limit ?? 50)) {
    const hasOffset = false; // TODO: track offset if we add it to CLI args
    if (hasOffset) {
      return `Showing ${resultCount} of ${totalMatched} matches. Use --limit or --offset to see more.`;
    }
    return `Showing ${resultCount} of ${totalMatched} matches. Use --limit ${Math.min(totalMatched, (limit ?? 50) + 50)} to see more, or --offset ${resultCount} for next page.`;
  }

  // Vague single-word query hint (common words that return too many results)
  if (isVagueWord) {
    return "Tip: Vague query — try adding more context (e.g., 'important from:alice' or 'urgent subject:budget')";
  }

  // Single-word query that's not a common vague word
  if (isSingleWord && words[0].length > 2 && !isVagueWord) {
    return "Tip: Narrow results with from:name or subject:keyword";
  }


  return undefined;
}

function serializeJsonPayload(
  rows: Array<Record<string, unknown> | string>,
  timings?: object,
  query?: string,
  resultCount?: number,
  totalMatched?: number,
  limit?: number,
  searchHint?: string,
  threads?: unknown[]
): string {
  const total = rows.length;
  const trueTotal = totalMatched ?? total; // Use provided totalMatched, fallback to rows.length
  const truncated = trueTotal > total;
  // Use searchHint from searchWithMeta if provided, otherwise fall back to getSearchHint
  const hint = searchHint ?? (query ? getSearchHint(query, resultCount ?? total, trueTotal, limit) : undefined);
  const hasMeta = truncated || timings || hint || (threads && threads.length > 0);

  for (let includeCount = total; includeCount >= 0; includeCount--) {
    const visible = rows.slice(0, includeCount);
    const payload = hasMeta
      ? {
          results: visible,
          ...(threads && threads.length > 0 ? { threads } : {}),
          truncated,
          totalMatched: trueTotal,
          returned: visible.length,
          ...(hint ? { hint } : {}),
          ...(timings ? { timings } : {}),
        }
      : visible;
    const json = JSON.stringify(payload, null, 2);
    if (Buffer.byteLength(json, "utf8") <= JSON_BYTE_CAP) {
      return json;
    }
  }

  return JSON.stringify(
    {
      results: [],
      ...(threads && threads.length > 0 ? { threads } : {}),
      truncated: true,
      totalMatched: trueTotal,
      returned: 0,
      ...(hint ? { hint } : {}),
      ...(timings ? { timings } : {}),
    },
    null,
    2
  );
}

interface MessageRow {
  id: number;
  message_id: string;
  thread_id: string;
  folder: string;
  uid: number;
  labels: string;
  from_address: string;
  from_name: string | null;
  to_addresses: string;
  cc_addresses: string;
  subject: string;
  date: string;
  body_text: string;
  raw_path: string;
  synced_at: string;
}

function parseRawFlag(rawArgs: string[], usage: string): { id: string; raw: boolean } {
  let id: string | undefined;
  let raw = false;

  for (const arg of rawArgs) {
    if (arg === "--raw") {
      raw = true;
      continue;
    }
    if (arg === "--help") {
      console.error(usage);
      process.exit(0);
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    if (id) {
      throw new Error("Too many positional arguments.");
    }
    id = arg;
  }

  if (!id) {
    throw new Error(`Usage: ${usage}`);
  }

  return { id, raw };
}

// formatMessageForOutput is now imported from ~/messages/presenter

/** Token-efficient hint for unknown command so the agent can self-correct. */
function getUnknownCommandHint(unknownCommand: string): string {
  // Handle common typos/variations
  if (unknownCommand === "refresh" || unknownCommand === "update") {
    return "Did you mean 'zmail refresh'?";
  }
  const c = unknownCommand.toLowerCase();
  if (c === "show" || c === "get" || c === "open" || c === "view") {
    return "Use: zmail read <message_id> to read a message, zmail search \"<query>\" to search.";
  }
  if (c === "find" || c === "lookup") {
    return "Use: zmail search \"<query>\" or zmail who <query>.";
  }
  return "Run 'zmail' for usage.";
}

const STATUS_LABEL_WIDTH = 13;

/**
 * Print sync and indexing status (reusable for status command and early exits)
 */
function printStatus(db: SqliteDatabase = getDb()): void {
  const status = getStatus(db);
  const pad = (s: string) => s.padEnd(STATUS_LABEL_WIDTH);

  // Calculate progress or status message if we have target, start, and current earliest dates
  // Only count NEW emails synced in this run, not pre-existing ones
  let progressText = "";
  if (status.sync.targetStartDate && status.sync.syncStartEarliestDate && status.sync.earliestSyncedDate) {
    try {
      // Parse dates (handle both YYYY-MM-DD and ISO format)
      const targetDateStr = status.sync.targetStartDate.slice(0, 10); // YYYY-MM-DD
      const startEarliestStr = status.sync.syncStartEarliestDate.slice(0, 10); // Where we started this sync
      const currentEarliestStr = status.sync.earliestSyncedDate.slice(0, 10); // Where we are now
      
      const targetDate = new Date(targetDateStr + "T00:00:00Z");
      const startEarliestDate = new Date(startEarliestStr + "T00:00:00Z");
      const currentEarliestDate = new Date(currentEarliestStr + "T00:00:00Z");
      
      // If we've already reached or passed the target, show 100%
      if (currentEarliestDate <= targetDate) {
        progressText = " (100% complete)";
      } else if (currentEarliestDate >= startEarliestDate) {
        // Still iterating through already-synced date range (internal crawl state; no user-facing progress)
        progressText = "";
      } else {
        // We're syncing new emails - calculate progress percentage
        // Total range to sync: from where we started (or target, whichever is older) down to target
        // Use the more recent (larger) date as the starting point
        const syncStartPoint = startEarliestDate > targetDate ? startEarliestDate : targetDate;
        const totalRangeDays = Math.ceil((syncStartPoint.getTime() - targetDate.getTime()) / (1000 * 60 * 60 * 24));
        
        // Progress made: how far we've gone from start point toward target
        const progressRangeDays = Math.ceil((syncStartPoint.getTime() - currentEarliestDate.getTime()) / (1000 * 60 * 60 * 24));
        
        if (totalRangeDays > 0) {
          const progress = Math.min(100, Math.max(0, Math.round((progressRangeDays / totalRangeDays) * 100)));
          progressText = ` (${progress}% complete)`;
        } else if (startEarliestDate <= targetDate) {
          // Already at or past target when sync started
          progressText = " (100% complete)";
        }
      }
    } catch (err) {
      // Invalid date format, skip progress
    }
  }

  // Sync status
  if (status.sync.isRunning) {
    console.log(`${pad("Sync:")} running${progressText}`);
  } else if (status.sync.lastSyncAt) {
    console.log(`${pad("Sync:")} idle (last: ${status.sync.lastSyncAt.slice(0, 10)}, ${status.sync.totalMessages} messages)${progressText}`);
  } else {
    console.log(`${pad("Sync:")} never run`);
  }

  // Search readiness
  console.log(`${pad("Search:")} FTS ready (${status.search.ftsReady})`);

  // Date range
  if (status.dateRange) {
    const earliest = status.dateRange.earliest.slice(0, 10);
    const latest = status.dateRange.latest.slice(0, 10);
    console.log(`${pad("Range:")} ${earliest} .. ${latest}`);
  }

  // Freshness: time since most recent mail and last sync (human + ISO 8601 duration)
  const latestMailAgo = formatTimeAgo(status.dateRange?.latest ?? null);
  const lastSyncAgo = status.sync.isRunning ? null : formatTimeAgo(status.sync.lastSyncAt);
  if (latestMailAgo) {
    console.log(`${pad("Newest mail:")} ${latestMailAgo.human} (${latestMailAgo.duration})`);
  }
  if (lastSyncAgo) {
    console.log(`${pad("Last sync:")} ${lastSyncAgo.human} (${lastSyncAgo.duration})`);
  }
}

async function main() {
  // Check schema version and rebuild if needed (before any command that uses the DB)
  const stale = checkSchemaVersion();
  if (stale) {
    process.stderr.write("Schema updated — rebuilding index from local cache (up to 20s)...\n");
    rmSync(config.dbPath, { force: true });
    getDb(); // creates fresh DB, sets user_version
    
    // Use sync log file for rebuild logging (same as sync command)
    const fileLogger = createFileLogger("sync");
    fileLogger.writeSeparator(process.pid);
    
    // Replace global logger with file logger for rebuild operations
    const restoreLogger = setLogger(fileLogger);
    
    let parsed = 0;
    try {
      fileLogger.info("Schema rebuild starting");
      const result = await reindexFromMaildir();
      parsed = result.parsed;
      fileLogger.info("Schema rebuild complete", { parsed });
    } finally {
      fileLogger.close();
      restoreLogger(); // Restore original logger
    }
    
    process.stderr.write(`Rebuild complete (${parsed} messages re-indexed).\n`);
  }

  switch (command) {
    case "sync": {
      // Sync: Initial setup, goes backward to fill gaps
      // Usage: zmail sync [--since <spec>] [--foreground]
      const sinceIdx = args.indexOf("--since");
      const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;
      if (sinceIdx >= 0 && (since === undefined || since.startsWith("-"))) {
        console.error("Usage: zmail sync [--since <spec>] [--foreground]");
        console.error("  --since  relative range: 7d, 5w, 3m, 2y (days, weeks, months, years)");
        console.error("  --foreground  run synchronously (default: background subprocess)");
        console.error("");
        console.error("Syncs email going backward from most recent, filling gaps in the specified date range.");
        console.error("Typically used for initial setup. For frequent updates, use 'zmail refresh'.");
        process.exit(1);
      }

      const foreground = args.includes("--foreground") || args.includes("--fg");

      // Foreground mode: run synchronously (original behavior)
      if (foreground) {
        // Sync always goes backward (fills gaps from most recent backward)
        const syncOptions: { since?: string; direction: 'backward' } = {
          direction: 'backward',
        };
        if (since) syncOptions.since = since;

        const syncResult = await runSync(syncOptions);

        const sec = (syncResult.durationMs / 1000).toFixed(2);
        const mb = (syncResult.bytesDownloaded / (1024 * 1024)).toFixed(2);
        const kbps = (syncResult.bandwidthBytesPerSec / 1024).toFixed(1);
        console.log("");
        console.log("Sync metrics:");
        console.log(`  messages:  ${syncResult.synced} new, ${syncResult.messagesFetched} fetched`);
        console.log(`  downloaded: ${mb} MB (${syncResult.bytesDownloaded} bytes)`);
        console.log(`  bandwidth: ${kbps} KB/s`);
        console.log(`  throughput: ${Math.round(syncResult.messagesPerMinute)} msg/min`);
        console.log(`  duration:  ${sec}s`);
        break;
      }

      // Background mode (default): spawn subprocess, wait until data flows, then exit
      const db = getDb();

      // Check lock before spawning
      const syncRow = db.prepare("SELECT is_running, owner_pid FROM sync_summary WHERE id = 1").get() as
        | { is_running: number; owner_pid: number | null }
        | undefined;
      if (syncRow?.is_running) {
        console.log(`Sync already running (PID: ${syncRow.owner_pid})\n`);
        printStatus(db);
        process.exit(0);
      }

      // Detect first-time indexing
      const messageCount = db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };
      const isFirstTime = messageCount.count === 0;

      // Spawn subprocess
      const entrypointScript = join(import.meta.dirname, "..", "index.ts");
      const subprocessArgs = ["tsx", entrypointScript, "--", "sync", "--foreground"];
      if (since) {
        subprocessArgs.push("--since", since);
      }

      const proc = spawn("npx", subprocessArgs, {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: "ignore",
        detached: true,
      });
      proc.unref();

      const pid = proc.pid!;
      const logPath = SYNC_LOG_PATH;

      // Poll until exit condition
      const POLL_INTERVAL_MS = 2000;
      const MAX_WAIT_MS = 60_000; // 1 minute (aim for 30s wow, but large mailboxes take longer to connect)
      const TARGET_COUNT = 20;
      const startTime = Date.now();
      let exitReason: 'data' | 'done' | 'timeout' = 'timeout';
      const imapHost = config.imap.host;
      let nonTtyPrintedConnecting = false;
      let nonTtyPrintedProgress = false;

      while (Date.now() - startTime < MAX_WAIT_MS) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const { count } = db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };
        const elapsed = Math.round((Date.now() - startTime) / 1000);

        if (process.stdout.isTTY) {
          if (count === 0) {
            process.stdout.write(`\rConnecting to IMAP server at ${imapHost}...`);
          } else {
            process.stdout.write(`\rWaiting for email... ${count} synced (${elapsed}s)`);
          }
        } else {
          if (count === 0) {
            if (!nonTtyPrintedConnecting) {
              process.stdout.write(`Connecting to IMAP server at ${imapHost}...`);
              nonTtyPrintedConnecting = true;
            }
          } else {
            if (!nonTtyPrintedProgress) {
              process.stdout.write(`Waiting for email... ${count} synced (${elapsed}s)`);
              nonTtyPrintedProgress = true;
            }
          }
        }

        if (count >= TARGET_COUNT) {
          exitReason = 'data';
          break;
        }
        if (!isProcessAlive(pid)) {
          exitReason = 'done';
          break;
        }
      }
      process.stdout.write("\n");

      // Print exit output
      // Always print PID, log, and status
      console.log("\nSync running in background.");
      console.log(`  PID:    ${pid}`);
      console.log(`  Log:    ${logPath}`);
      console.log(`  Status: zmail status`);

      // Add encouraging first-time messages
      if (exitReason === 'data' && isFirstTime) {
        const { count } = db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };
        console.log(`\nData is flowing! ${count} messages synced so far — search is ready.\n`);
        console.log("Try a few queries to see what's in your inbox:");
        console.log('  zmail search "invoice"');
        console.log('  zmail search "from:boss@example.com"');
        console.log('  zmail who "alice"');
      } else if (exitReason === 'done' && isFirstTime) {
        const { count } = db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };
        
        // BUG-007 fix: Check sync log for errors before printing success
        const logCheck = checkSyncLogForErrors();
        if (logCheck.hasError) {
          console.error(`\nSync failed: ${logCheck.errorMessage}`);
          console.error(`Check log: ${logPath}`);
          process.exit(1);
        }
        
        if (count === 0) {
          console.warn("\nWarning: 0 messages synced. This may indicate:");
          console.warn("  - Invalid IMAP credentials (check with 'zmail setup')");
          console.warn("  - No messages in the specified date range");
          console.warn(`  - Check sync log: ${logPath}`);
        } else {
          console.log(`\nSync complete! ${count} messages synced and indexed.`);
          console.log("Try: zmail search \"your query\"  |  zmail who \"name\"");
        }
      } else if (exitReason === 'timeout') {
        const { count } = db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };
        if (count === 0) {
          console.warn("\nWarning: No messages synced yet. This may indicate:");
          console.warn("  - Invalid IMAP credentials (check with 'zmail setup')");
          console.warn("  - Large mailbox taking longer to connect");
          console.warn(`  - Check sync log: ${logPath}`);
        } else {
          console.log("\n(Large mailboxes may take longer to connect — sync continues in background)");
        }
      }

      process.exit(0);
    }

    case "search": {
      let parsed: ParsedSearchArgs;
      try {
        parsed = parseSearchArgs(args);
      } catch (err) {
        searchUsage();
        console.error(err instanceof Error ? `\n${err.message}` : String(err));
        console.error("\nExample: zmail search \"from:alice@example.com invoice OR receipt\"");
        process.exit(1);
      }

      const forceJsonForAdvancedFlags = parsed.idsOnly || parsed.timings || !!parsed.fields?.length;
      const shouldOutputJson = !parsed.forceText || forceJsonForAdvancedFlags;
      let effectiveLimit = parsed.limit;
      if (shouldOutputJson && effectiveLimit && effectiveLimit > JSON_LIMIT_CAP) {
        console.error(
          `--limit ${effectiveLimit} is too large for JSON mode; capping to ${JSON_LIMIT_CAP} for stable output.`
        );
        effectiveLimit = JSON_LIMIT_CAP;
      }

      const db = getDb();
      const effectiveDetail = resolveDetail(parsed.detail, parsed.fields);
      let run;
      try {
        run = await searchWithMeta(db, {
          query: parsed.query,
          fromAddress: parsed.fromAddress,
          afterDate: parsed.afterDate,
          beforeDate: parsed.beforeDate,
          limit: effectiveLimit,
          includeThreads: parsed.threads,
        });
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      let results: Array<SearchResult & { body?: string }> = run.results;
      if (effectiveDetail === "body") {
        results = hydrateBodies(db, run.results);
      }

      if (shouldOutputJson) {
        const rows = parsed.idsOnly
          ? results.map((r) => r.messageId)
          : results.map((r) => projectResult(r, effectiveDetail, parsed.fields));
        const json = serializeJsonPayload(
          rows,
          parsed.timings ? run.timings : undefined,
          parsed.query,
          results.length,
          run.totalMatched ?? results.length,
          effectiveLimit,
          parsed.query ? getSearchHint(parsed.query, results.length, run.totalMatched ?? results.length, effectiveLimit) : undefined,
          parsed.threads && run.threads?.length ? run.threads : undefined
        );
        console.log(json);
        break;
      }

      if (results.length === 0) {
        console.log("No results found.");
        const hint = getSearchHint(parsed.query, 0, 0, effectiveLimit);
        if (hint) {
          console.log(`\n${hint}`);
        }
        break;
      }

      const totalMatched = run.totalMatched ?? results.length;
      console.log(`Found ${results.length} result${results.length === 1 ? "" : "s"}${totalMatched > results.length ? ` (of ${totalMatched} total)` : ""}:\n`);
      if (effectiveDetail === "headers") {
        console.log("  DATE        FROM                 SUBJECT                          MESSAGE ID");
        console.log("  " + "-".repeat(96));
        for (const r of results) {
          const date = r.date.slice(0, 10);
          const from = (r.fromName ? `${r.fromName} ` : "") + `<${r.fromAddress}>`;
          const fromShort = from.length > 20 ? from.slice(0, 17) + "..." : from.padEnd(20);
          const subjectShort = r.subject.length > 30 ? r.subject.slice(0, 27) + "..." : r.subject.padEnd(30);
          const idShort = r.messageId.length > 34 ? r.messageId.slice(0, 31) + "..." : r.messageId;
          console.log(`  ${date}  ${fromShort}  ${subjectShort}  ${idShort}`);
        }
      } else {
        console.log("  DATE        FROM                 SUBJECT                          SNIPPET");
        console.log("  " + "-".repeat(80));
        for (const r of results) {
          const date = r.date.slice(0, 10);
          const from = (r.fromName ? `${r.fromName} ` : "") + `<${r.fromAddress}>`;
          const fromShort = from.length > 20 ? from.slice(0, 17) + "..." : from.padEnd(20);
          const subjectShort = r.subject.length > 30 ? r.subject.slice(0, 27) + "..." : r.subject.padEnd(30);
          const snippetClean = r.snippet.replace(/<[^>]+>/g, "").trim();
          const snippetShort = snippetClean.length > 30 ? snippetClean.slice(0, 27) + "..." : snippetClean;
          console.log(`  ${date}  ${fromShort}  ${subjectShort}  ${snippetShort}`);
        }
      }

      if (parsed.threads && run.threads?.length) {
        console.log("\nThreads (full conversations):");
        for (const thread of run.threads) {
          console.log(`\n  Thread: ${thread.subject} (${thread.threadId})`);
          for (const msg of thread.messages) {
            const from = (msg.fromName ? `${msg.fromName} ` : "") + `<${msg.fromAddress}>`;
            console.log(`    ${msg.date.slice(0, 10)}  ${from}`);
            console.log(`    ${msg.subject}`);
            if (msg.bodyPreview?.trim()) {
              const preview = msg.bodyPreview.replace(/\n/g, " ").slice(0, 120);
              console.log(`    ${preview}${msg.bodyPreview.length > 120 ? "…" : ""}`);
            }
            console.log("");
          }
        }
      }

      // Show actionable hints after results (only in text mode, not JSON)
      const hint = getSearchHint(parsed.query, results.length, totalMatched, effectiveLimit);
      if (hint) {
        console.log(`\n${hint}`);
      }
      break;
    }

    case "who": {
      let whoParsed: ParsedWhoArgs;
      try {
        whoParsed = parseWhoArgs(args);
      } catch (err) {
        whoUsage();
        console.error(err instanceof Error ? `\n${err.message}` : String(err));
        process.exit(1);
      }

      const shouldOutputJson = !whoParsed.forceText;

      const db = getDb();
      const ownerAddress = config.imap.user?.trim() || undefined;

      const startTime = Date.now();
      const result = await who(db, {
        query: whoParsed.query,
        limit: whoParsed.limit,
        minSent: whoParsed.minSent,
        minReceived: whoParsed.minReceived,
        includeNoreply: whoParsed.includeNoreply,
        ownerAddress,
        enrich: whoParsed.enrich,
      });
      const duration = Date.now() - startTime;

      // Add timing info for performance monitoring
      if (shouldOutputJson) {
        (result as WhoResult & { _timing?: { ms: number } })._timing = { ms: duration };
      } else if (whoParsed.dynamic) {
        // Show timing in text mode if --dynamic flag was explicitly used (for testing)
        console.log(`\n[Query took ${duration}ms]\n`);
      }

      if (shouldOutputJson) {
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      if (result.people.length === 0) {
        console.log("No matching people found.");
        if (result.hint) {
          console.log(`\n${result.hint}`);
        }
        break;
      }

      console.log(`People matching "${result.query}":\n`);
      for (const p of result.people) {
        // Display name: use firstname/lastname if available, otherwise name field
        const name = (p.firstname && p.lastname) 
          ? `${p.firstname} ${p.lastname}`
          : p.name || (p.firstname || p.lastname) || "Unknown";
        const akaStr = p.aka && p.aka.length > 0 ? ` (aka: ${p.aka.join(", ")})` : "";
        console.log(`  ${name}${akaStr}`);
        console.log(`    Primary: ${p.primaryAddress}`);
        if (p.addresses.length > 1) {
          const otherAddrs = p.addresses.filter((a) => a !== p.primaryAddress);
          console.log(`    Other addresses: ${otherAddrs.join(", ")}`);
        }
        if (p.phone) {
          console.log(`    Phone: ${p.phone}`);
        }
        if (p.title || p.company) {
          const titleCompany = [p.title, p.company].filter(Boolean).join(" at ");
          console.log(`    ${titleCompany}`);
        }
        if (p.urls && p.urls.length > 0) {
          console.log(`    URLs: ${p.urls.join(", ")}`);
        }
        console.log(
          `    Counts: ${p.sentCount} sent, ${p.receivedCount} received, ${p.mentionedCount} mentioned`
        );
        if (p.lastContact) {
          console.log(`    Last contact: ${p.lastContact}`);
        }
        console.log("");
      }
      
      if (result.hint) {
        console.log(result.hint);
      }
      break;
    }

    case "thread": {
      let threadId: string | undefined;
      let raw = false;
      let json = false;

      for (const arg of args) {
        if (arg === "--raw") {
          raw = true;
          continue;
        }
        if (arg === "--json") {
          json = true;
          continue;
        }
        if (arg === "--help") {
          console.error("Usage: zmail thread <thread_id> [--json] [--raw]");
          console.error("  --json    output JSON (default: text)");
          console.error("  --raw     include raw .eml content");
          process.exit(0);
        }
        if (arg.startsWith("-")) {
          throw new Error(`Unknown flag: ${arg}`);
        }
        if (threadId) {
          throw new Error("Too many positional arguments.");
        }
        threadId = arg;
      }

      if (!threadId) {
        throw new Error("Usage: zmail thread <thread_id> [--json] [--raw]");
      }

      const db = getDb();
      const normalizedThreadId = normalizeMessageId(threadId);
      const messages = db
        .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY date ASC")
        .all(normalizedThreadId) as MessageRow[];

      if (messages.length === 0) {
        if (json) {
          console.log("[]");
          break;
        }
        console.error(`Thread not found: ${threadId}`);
        process.exit(1);
      }

      if (json) {
        const shaped = await Promise.all(messages.map((m) => formatMessageForOutput(m, raw)));
        console.log(JSON.stringify(shaped, null, 2));
      } else {
        // Text format: format each message with formatMessageLlmFriendly
        const total = messages.length;
        for (let i = 0; i < messages.length; i++) {
          const message = messages[i];
          const shaped = await formatMessageForOutput(message, raw);
          if (total > 1) {
            console.log(`=== Message ${i + 1} of ${total} ===`);
          }
          console.log(formatMessageLlmFriendly(message, shaped));
          if (i < messages.length - 1) {
            console.log("");
          }
        }
      }
      break;
    }

    case "read":
    case "message": {
      const readUsage = command === "read" ? "zmail read <message_id> [--raw]" : "zmail message <message_id> [--raw]";
      let parsed;
      try {
        parsed = parseRawFlag(args, readUsage);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      const db = getDb();
      const messageId = normalizeMessageId(parsed.id);
      const message = db
        .prepare("SELECT * FROM messages WHERE message_id = ?")
        .get(messageId) as MessageRow | undefined;
      if (!message) {
        console.error(`Message not found: ${messageId}`);
        process.exit(1);
      }
      const shaped = await formatMessageForOutput(message, parsed.raw);
      console.log(formatMessageLlmFriendly(message, shaped));
      break;
    }

    case "refresh": {
      // Refresh: Frequent updates, brings local copy up to date
      // Usage: zmail refresh
      // No --since needed - uses last_uid checkpoint to fetch only new messages

      // Refresh always goes forward (fetches new messages since last sync)
      const syncOptions: { direction: 'forward' } = {
        direction: 'forward',
      };

      const syncResult = await runSync(syncOptions);

      const sec = (syncResult.durationMs / 1000).toFixed(2);
      const mb = (syncResult.bytesDownloaded / (1024 * 1024)).toFixed(2);
      const kbps = (syncResult.bandwidthBytesPerSec / 1024).toFixed(1);
      console.log("");
      console.log("Refresh metrics:");
      console.log(`  messages:  ${syncResult.synced} new, ${syncResult.messagesFetched} fetched`);
      console.log(`  downloaded: ${mb} MB (${syncResult.bytesDownloaded} bytes)`);
      console.log(`  bandwidth: ${kbps} KB/s`);
      console.log(`  throughput: ${Math.round(syncResult.messagesPerMinute)} msg/min`);
      console.log(`  duration:  ${sec}s`);
      break;
    }

    case "status": {
      const showImapStatus = args.includes("--imap") || args.includes("--server");
      const outputJson = args.includes("--json");
      
      const db = getDb();
      
      if (outputJson) {
        const status = getStatus(db);
        const output: Record<string, unknown> = { ...status };
        const latestMailAgo = formatTimeAgo(status.dateRange?.latest ?? null);
        const lastSyncAgo = status.sync.isRunning ? null : formatTimeAgo(status.sync.lastSyncAt);
        output.freshness = {
          latestMailAgo: latestMailAgo ?? null,
          lastSyncAgo: lastSyncAgo ?? null,
        };
        
        if (showImapStatus) {
          const imapComparison = await getImapServerStatus(db);
          if (imapComparison) {
            output.imap = imapComparison;
          }
        }
        
        console.log(JSON.stringify(output, null, 2));
      } else {
        printStatus(db);

        // Compare with server using STATUS (only if flag is provided)
        if (showImapStatus) {
          const imapComparison = await getImapServerStatus(db);
          if (imapComparison) {
            console.log("");
            console.log("Server comparison:");
            console.log(`  Server:   ${imapComparison.server.messages} messages, UIDNEXT=${imapComparison.server.uidNext ?? 'unknown'}, UIDVALIDITY=${imapComparison.server.uidValidity ?? 'unknown'}`);
            console.log(`  Local:    ${imapComparison.local.messages} messages, last_uid=${imapComparison.local.lastUid ?? 'none'}, UIDVALIDITY=${imapComparison.local.uidValidity ?? 'none'}`);
            
            if (imapComparison.missing !== null && imapComparison.missing > 0 && imapComparison.missingUidRange) {
              console.log(`  Missing:  ${imapComparison.missing} new message(s) (UIDs ${imapComparison.missingUidRange.start}..${imapComparison.missingUidRange.end})`);
            } else if (imapComparison.missing === 0) {
              console.log(`  Status:   Up to date (no new messages)`);
            }
            
            if (imapComparison.uidValidityMismatch) {
              console.log(`  Warning:  UIDVALIDITY mismatch - mailbox may have been reset`);
            }
            
            if (imapComparison.coverage) {
              console.log(`  Coverage: Goes back ${imapComparison.coverage.daysAgo} days (${imapComparison.coverage.yearsAgo} years) to ${imapComparison.coverage.earliestDate}`);
            }
          }
        } else {
          console.log("");
          const syncStatus = getStatus(db);
          const TEN_MIN_MS = 10 * 60 * 1000; // 10 minutes
          const lastSyncAt = syncStatus.sync.lastSyncAt;
          const lastSyncMs = lastSyncAt
            ? Date.now() - (lastSyncAt.includes("Z") || lastSyncAt.includes("+")
                ? new Date(lastSyncAt).getTime()
                : new Date(lastSyncAt.replace(" ", "T") + "Z").getTime())
            : 0;
          if (!syncStatus.sync.isRunning && lastSyncMs > TEN_MIN_MS) {
            console.log("Hint: Run 'zmail refresh' to fetch the latest emails");
          }
          console.log("Hint: Add --imap flag to show IMAP server status (may take 10+ seconds longer)");
        }
      }
      
      break;
    }

    case "stats": {
      const outputJson = args.includes("--json");
      const db = getDb();
      const total = db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };
      const dateRange = db.prepare("SELECT MIN(date) as earliest, MAX(date) as latest FROM messages").get() as
        | { earliest: string | null; latest: string | null }
        | undefined;
      const topSenders = db
        .prepare(
          "SELECT from_address, COUNT(*) as count FROM messages GROUP BY from_address ORDER BY count DESC LIMIT 10"
        )
        .all() as Array<{ from_address: string; count: number }>;
      const folderBreakdown = db
        .prepare("SELECT folder, COUNT(*) as count FROM messages GROUP BY folder ORDER BY count DESC")
        .all() as Array<{ folder: string; count: number }>;

      if (outputJson) {
        console.log(
          JSON.stringify(
            {
              totalMessages: total.count,
              dateRange: dateRange?.earliest && dateRange?.latest
                ? {
                    earliest: dateRange.earliest.slice(0, 10),
                    latest: dateRange.latest.slice(0, 10),
                  }
                : null,
              topSenders: topSenders.map((s) => ({
                address: s.from_address,
                count: s.count,
              })),
              folders: folderBreakdown.map((f) => ({
                folder: f.folder,
                count: f.count,
              })),
            },
            null,
            2
          )
        );
      } else {
        console.log("Database Statistics\n");
        console.log(`Total messages: ${total.count}`);
        if (dateRange?.earliest && dateRange?.latest) {
          console.log(`Date range: ${dateRange.earliest.slice(0, 10)} to ${dateRange.latest.slice(0, 10)}`);
        }
        console.log("\nTop senders:");
        for (const sender of topSenders) {
          console.log(`  ${sender.from_address.padEnd(40)} ${sender.count}`);
        }
        console.log("\nMessages by folder:");
        for (const folder of folderBreakdown) {
          console.log(`  ${folder.folder.padEnd(40)} ${folder.count}`);
        }
      }
      break;
    }

    case "attachment":
    case "attachments": {
      if (args.length === 0) {
        console.error("Usage: zmail attachment list <message_id>");
        console.error("       zmail attachment read <message_id> <index_or_filename> [--raw] [--no-cache]");
        process.exit(1);
      }

      const subcommand = args[0];
      if (subcommand === "list") {
        const messageIdArg = args[1];
        if (!messageIdArg) {
          console.error("Usage: zmail attachment list <message_id>");
          process.exit(1);
        }

        const db = getDb();
        const messageId = normalizeMessageId(messageIdArg);
        
        // Check if message exists first
        const messageExists = db
          .prepare("SELECT 1 FROM messages WHERE message_id = ?")
          .get(messageId);
        const shouldOutputJson = !args.includes("--text");
        if (!messageExists) {
          if (shouldOutputJson) {
            console.log("[]");
            break;
          }
          // In text mode, output "No attachments found." to stdout for consistency
          console.log("No attachments found.");
          break;
        }

        const attachments = db
          .prepare(
            `SELECT id, filename, mime_type, size, stored_path, extracted_text
             FROM attachments WHERE message_id = ? ORDER BY filename`
          )
          .all(messageId) as Array<{
          id: number;
          filename: string;
          mime_type: string;
          size: number;
          stored_path: string;
          extracted_text: string | null;
        }>;

        const quotedMsgId = messageId.includes(" ") ? `"${messageId}"` : messageId;
        if (shouldOutputJson) {
          console.log(
            JSON.stringify(
              attachments.map((a, i) => ({
                index: i + 1,
                filename: a.filename,
                mimeType: a.mime_type,
                size: a.size,
                extracted: a.extracted_text !== null,
                readCommand: `zmail attachment read ${quotedMsgId} ${i + 1}`,
                readCommandByFilename: `zmail attachment read ${quotedMsgId} "${a.filename.replace(/"/g, '\\"')}"`,
              })),
              null,
              2
            )
          );
        } else {
          if (attachments.length === 0) {
            console.log("No attachments found.");
            break;
          }
          console.log(`Attachments for ${messageId}:\n`);
          console.log("  #    FILENAME".padEnd(50) + "  MIME TYPE".padEnd(40) + "  SIZE      EXTRACTED");
          console.log("  " + "-".repeat(110));
          for (let i = 0; i < attachments.length; i++) {
            const att = attachments[i];
            const sizeStr =
              att.size >= 1024 * 1024
                ? `${(att.size / (1024 * 1024)).toFixed(2)} MB`
                : att.size >= 1024
                  ? `${(att.size / 1024).toFixed(2)} KB`
                  : `${att.size} B`;
            const filenameShort = att.filename.length > 40 ? att.filename.slice(0, 37) + "..." : att.filename.padEnd(40);
            const mimeShort = att.mime_type.length > 38 ? att.mime_type.slice(0, 35) + "..." : att.mime_type.padEnd(38);
            console.log(`  ${String(i + 1).padStart(4)}  ${filenameShort}  ${mimeShort}  ${sizeStr.padStart(9)}  ${att.extracted_text !== null ? "yes" : "no"}`);
          }
          console.log("\nTo read an attachment (extracted text/CSV to stdout):");
          console.log(`  zmail attachment read <message_id> <index>   # index 1-${attachments.length}`);
          console.log(`  zmail attachment read <message_id> "<filename>"`);
          console.log(`  Example: zmail attachment read ${quotedMsgId} 1`);
          console.log("To get raw bytes: add --raw");
        }
      } else if (subcommand === "read") {
        const raw = args.includes("--raw");
        const noCache = args.includes("--no-cache");
        const readArgs = args.filter((a) => a !== "--raw" && a !== "--no-cache");
        const messageIdArg = readArgs[1];
        const indexOrFilename = readArgs[2];
        if (!messageIdArg || indexOrFilename === undefined) {
          console.error("Usage: zmail attachment read <message_id> <index_or_filename> [--raw] [--no-cache]");
          process.exit(1);
        }

        const db = getDb();
        const messageId = normalizeMessageId(messageIdArg);
        const list = db
          .prepare(
            `SELECT id, message_id, filename, mime_type, size, stored_path
             FROM attachments WHERE message_id = ? ORDER BY filename`
          )
          .all(messageId) as Array<{
          id: number;
          message_id: string;
          filename: string;
          mime_type: string;
          size: number;
          stored_path: string;
        }>;
        if (list.length === 0) {
          console.error(`No attachments found for message.`);
          process.exit(1);
        }
        const indexNum = Number.parseInt(indexOrFilename, 10);
        const attachment =
          Number.isFinite(indexNum) && indexNum >= 1 && indexNum <= list.length
            ? list[indexNum - 1]
            : list.find((a) => a.filename === indexOrFilename);
        if (!attachment) {
          console.error(`No attachment "${indexOrFilename}" in this message. Use index 1-${list.length} or exact filename.`);
          process.exit(1);
        }

        const absPath = join(config.maildirPath, attachment.stored_path);

        if (raw) {
          // Output raw binary
          try {
            const rawBuffer = readFileSync(absPath);
            process.stdout.write(rawBuffer);
          } catch (err) {
            console.error(`Failed to read attachment file: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }
        } else {
          // Extract and output text (use --no-cache to force re-extraction and ignore cached result)
          try {
            const { text } = await extractAndCache(
              absPath,
              attachment.mime_type,
              attachment.filename,
              attachment.id,
              noCache
            );
            console.log(text);
          } catch (err) {
            console.error(`Failed to extract attachment: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }
        }
      } else {
        console.error(`Unknown subcommand: ${subcommand}`);
        console.error("Usage: zmail attachment list <message_id>");
        console.error("       zmail attachment read <message_id> <index_or_filename> [--raw] [--no-cache]");
        process.exit(1);
      }
      break;
    }

    case "mcp": {
      await startMcpServer();
      break;
    }

    default: {
      if (command) {
        const hint = getUnknownCommandHint(command);
        console.error(`Unknown command: ${command}. ${hint}`);
        process.exit(1);
      }
      console.log(`zmail — agent-first email

Usage:
  zmail sync [--since <spec>]     Initial sync: fill gaps going backward (e.g. --since 7d, 5w, 3m, 2y)
  zmail refresh                    Refresh: fetch new messages since last sync (frequent updates)
  zmail search <query> [flags]     Search email (FTS5 full-text search)
  zmail who <query> [flags]        Find people by address or name (see --help for flags)
  zmail status [--json] [--imap]   Sync/indexing status; --imap: compare with server
  zmail stats [--json]             Database statistics
  zmail read <id> [--raw]          Read a message (or: zmail message <id>)
  zmail thread <id> [--json] [--raw]   Fetch thread (text by default)
  zmail attachment list <message_id>   List attachments (use message_id from search)
  zmail attachment read <message_id> <index>|<filename> [--raw] [--no-cache]   Read by index (1-based) or filename
  zmail mcp                        Start MCP server (stdio)

Agent interfaces:
  CLI (this): Use for direct subprocess calls. Fast for one-off queries. Commands default to JSON (search, who, attachment list) or text (read, thread, status, stats). Use --text or --json flags to override.
  MCP: Use for persistent tool-based integration. Run 'zmail mcp' to start stdio server. Search returns bodyPreview and attachment metadata per result; use includeThreads: true for full threads, get_messages([ids]) to batch-read. See docs/MCP.md.

Run 'zmail setup' for setup instructions.
`);
    }
  }
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
