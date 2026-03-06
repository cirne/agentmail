import { runSync } from "~/sync";
import { searchWithMeta, type SearchMode } from "~/search";
import { who } from "~/search/who";
import { indexMessages } from "~/search/indexing";
import { getDb } from "~/db";
import { startMcpServer } from "~/mcp";
import { config } from "~/lib/config";
import { logger } from "~/lib/logger";
import { parseSinceToDate } from "~/sync/parse-since";
import { htmlToMarkdown } from "~/lib/content-normalize";
import { parseRawMessage } from "~/sync/parse-message";
import type { SearchResult } from "~/lib/types";
import type { SqliteDatabase } from "~/db";
import { readFileSync } from "fs";
import { join } from "path";
import { formatMessageLlmFriendly } from "~/cli/format-message";
import { extractAndCache } from "~/attachments";

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
  | "body";

const VALID_MODES = new Set<SearchMode>(["auto", "fts", "semantic", "hybrid"]);
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
  "body",
]);
const DEFAULT_HEADER_FIELDS: SearchField[] = [
  "messageId",
  "threadId",
  "date",
  "fromAddress",
  "fromName",
  "subject",
  "rank",
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
  mode: SearchMode;
  detail: SearchDetail;
  fields?: SearchField[];
  forceJson: boolean;
  idsOnly: boolean;
  timings: boolean;
}

function searchUsage() {
  console.error("Usage: zmail search <query> [flags]");
  console.error("");
  console.error("Query can use inline operators: from:, to:, subject:, after:, before:");
  console.error("  Example: zmail search \"from:alice@example.com invoice OR receipt\"");
  console.error("  Example: zmail search \"after:7d subject:meeting\"");
  console.error("");
  console.error("Flags:");
  console.error("  --limit <n>        max results (default: 20)");
  console.error("  --mode <mode>      auto | fts | semantic | hybrid (default: auto)");
  console.error("  --detail <level>   headers | snippet | body (default: headers)");
  console.error("  --fields <csv>     projection fields, e.g. messageId,subject,date");
  console.error("  --ids-only         return only message IDs");
  console.error("  --timings          include machine-readable search timings");
  console.error("  --json             force JSON output (default: table for TTY, JSON when piped)");
}

interface ParsedWhoArgs {
  query: string;
  limit?: number;
  minSent?: number;
  minReceived?: number;
  forceJson: boolean;
}

function whoUsage() {
  console.error("Usage: zmail who <query> [flags]");
  console.error("  --json             output JSON (default: table for TTY, JSON when piped)");
  console.error("  --limit <n>        max results (default: 50)");
  console.error("  --min-sent <n>     minimum sent count");
  console.error("  --min-received <n> minimum received count");
}

function parseWhoArgs(rawArgs: string[]): ParsedWhoArgs {
  const parsed: ParsedWhoArgs = {
    query: "",
    forceJson: false,
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
    if (arg === "--json") {
      parsed.forceJson = true;
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
    mode: "auto",
    detail: "headers",
    forceJson: false,
    idsOnly: false,
    timings: false,
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
    if (arg === "--json") {
      parsed.forceJson = true;
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
    if (arg === "--mode") {
      const mode = readValue(arg) as SearchMode;
      if (!VALID_MODES.has(mode)) {
        throw new Error(`Invalid --mode: "${mode}". Use auto, fts, semantic, or hybrid.`);
      }
      parsed.mode = mode;
      continue;
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

function serializeJsonPayload(
  rows: Array<Record<string, unknown> | string>,
  timings?: object
): string {
  const total = rows.length;
  for (let includeCount = total; includeCount >= 0; includeCount--) {
    const visible = rows.slice(0, includeCount);
    const truncated = includeCount < total;
    const payload =
      truncated || timings
        ? {
            results: visible,
            truncated,
            totalMatched: total,
            returned: visible.length,
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
      truncated: true,
      totalMatched: total,
      returned: 0,
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
  embedding_state: string;
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

function readRawEmail(rawPath: string): Buffer | null {
  if (!rawPath) return null;
  const absPath = join(config.maildirPath, rawPath);
  try {
    return readFileSync(absPath);
  } catch {
    return null;
  }
}

export async function formatMessageForOutput(message: MessageRow, raw: boolean): Promise<Record<string, unknown>> {
  const db = getDb();
  const attachments = db
    .prepare(
      `SELECT id, filename, mime_type, size, stored_path, extracted_text
       FROM attachments WHERE message_id = ? ORDER BY filename`
    )
    .all(message.message_id) as Array<{
    id: number;
    filename: string;
    mime_type: string;
    size: number;
    stored_path: string;
    extracted_text: string | null;
  }>;

  if (raw) {
    const rawEmail = readRawEmail(message.raw_path);
    return {
      ...message,
      content: {
        format: "raw",
        source: "eml",
        eml: rawEmail ? rawEmail.toString("utf8") : null,
      },
      attachments: attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mime_type,
        size: a.size,
        extracted: a.extracted_text !== null,
      })),
    };
  }

  const { body_text, ...rest } = message;
  let body = (body_text ?? "").trim();
  let source: "body_text" | "html" | "text" | "empty" = body ? "body_text" : "empty";

  if (!body && message.raw_path) {
    const rawEmail = readRawEmail(message.raw_path);
    if (rawEmail) {
      try {
        const parsed = await parseRawMessage(rawEmail);
        if (parsed.bodyHtml) {
          const markdown = htmlToMarkdown(parsed.bodyHtml);
          if (markdown) {
            body = markdown;
            source = "html";
          }
        }
        if (!body && parsed.bodyText) {
          body = (parsed.bodyText ?? "").trim();
          if (body) source = "text";
        }
      } catch (err) {
        // Log parsing errors for debugging
        const { logger } = await import("~/lib/logger");
        logger.warn("Failed to parse raw email for message", {
          messageId: message.message_id,
          rawPath: message.raw_path,
          error: err instanceof Error ? err.message : String(err),
        });
        // fall through to empty content
      }
    } else {
      // Log when raw email file can't be read
      const { logger } = await import("~/lib/logger");
      logger.warn("Could not read raw email file", {
        messageId: message.message_id,
        rawPath: message.raw_path,
      });
    }
  }

  // Ensure body is never null/undefined - use empty string if parsing failed
  const finalBody = body || "";
  
  return {
    ...rest,
    content: {
      format: source === "html" ? "markdown" : "text",
      source,
      markdown: finalBody,
    },
    attachments: attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mime_type,
      size: a.size,
      extracted: a.extracted_text !== null,
    })),
  };
}

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

async function main() {
  switch (command) {
    case "sync": {
      // Sync: Initial setup, goes backward to fill gaps
      // Usage: zmail sync [--since <spec>]
      const sinceIdx = args.indexOf("--since");
      const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;
      if (sinceIdx >= 0 && (since === undefined || since.startsWith("-"))) {
        console.error("Usage: zmail sync [--since <spec>]");
        console.error("  --since  relative range: 7d, 5w, 3m, 2y (days, weeks, months, years)");
        console.error("");
        console.error("Syncs email going backward from most recent, filling gaps in the specified date range.");
        console.error("Typically used for initial setup. For frequent updates, use 'zmail refresh'.");
        process.exit(1);
      }

      // Run sync (bandwidth-bound) and indexing (API-rate-bound) concurrently (ADR-020).
      // syncDone resolves when sync finishes inserting messages, signaling the indexer
      // to drain the queue and exit — regardless of whether sync found 0 or 1000 messages.
      let resolveSyncDone!: () => void;
      const syncDone = new Promise<void>((resolve) => { resolveSyncDone = resolve; });

      // Sync always goes backward (fills gaps from most recent backward)
      const syncOptions: { since?: string; direction: 'backward'; onLogPath?: (logPath: string) => void } = {
        direction: 'backward',
      };
      if (since) syncOptions.since = since;
      
      // Print log path immediately when sync starts (useful for background execution)
      syncOptions.onLogPath = (logPath: string) => {
        console.log(`Sync log: ${logPath}`);
      };

      const syncPromise = runSync(syncOptions).then((result) => {
        resolveSyncDone();
        return result;
      });
      const indexPromise = indexMessages({ syncDone });

      // Wait for both to complete
      const [syncResult, indexResult] = await Promise.all([syncPromise, indexPromise]);

      // Log path already printed at start via onLogPath callback
      if (syncResult) {
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
      }

      if (indexResult.indexed > 0 || indexResult.failed > 0) {
        const sec = (indexResult.durationMs / 1000).toFixed(2);
        console.log("");
        console.log("Indexing metrics:");
        console.log(`  indexed:    ${indexResult.indexed}`);
        if (indexResult.skipped > 0) console.log(`  skipped:    ${indexResult.skipped}`);
        if (indexResult.failed > 0) console.log(`  failed:     ${indexResult.failed}`);
        console.log(`  throughput: ${indexResult.messagesPerMinute} msg/min`);
        console.log(`  duration:   ${sec}s`);
      }
      break;
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

      const isTty = process.stdout.isTTY;
      const forceJsonForAdvancedFlags = parsed.idsOnly || parsed.timings || !!parsed.fields?.length;
      const shouldOutputJson = parsed.forceJson || !isTty || forceJsonForAdvancedFlags;
      let effectiveLimit = parsed.limit;
      if (shouldOutputJson && effectiveLimit && effectiveLimit > JSON_LIMIT_CAP) {
        console.error(
          `--limit ${effectiveLimit} is too large for JSON mode; capping to ${JSON_LIMIT_CAP} for stable output.`
        );
        effectiveLimit = JSON_LIMIT_CAP;
      }

      const db = getDb();
      const effectiveDetail = resolveDetail(parsed.detail, parsed.fields);
      const run = await searchWithMeta(db, {
        query: parsed.query,
        fromAddress: parsed.fromAddress,
        afterDate: parsed.afterDate,
        beforeDate: parsed.beforeDate,
        limit: effectiveLimit,
        mode: parsed.mode,
      });

      let results: Array<SearchResult & { body?: string }> = run.results;
      if (effectiveDetail === "body") {
        results = hydrateBodies(db, run.results);
      }

      if (shouldOutputJson) {
        const rows = parsed.idsOnly
          ? results.map((r) => r.messageId)
          : results.map((r) => projectResult(r, effectiveDetail, parsed.fields));
        const json = serializeJsonPayload(rows, parsed.timings ? run.timings : undefined);
        console.log(json);
        break;
      }

      if (results.length === 0) {
        console.log("No results found.");
        break;
      }

      console.log(`Found ${results.length} result${results.length === 1 ? "" : "s"}:\n`);
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

      const isTty = process.stdout.isTTY;
      const shouldOutputJson = whoParsed.forceJson || !isTty;

      const db = getDb();
      const ownerAddress = config.imap.user?.trim() || undefined;
      const result = who(db, {
        query: whoParsed.query,
        limit: whoParsed.limit,
        minSent: whoParsed.minSent,
        minReceived: whoParsed.minReceived,
        ownerAddress,
      });

      if (shouldOutputJson) {
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      if (result.people.length === 0) {
        console.log("No matching people found.");
        break;
      }

      console.log(`People matching "${result.query}":\n`);
      console.log("  ADDRESS".padEnd(44) + "  DISPLAY NAME".padEnd(24) + "  SENT   RECV   MENTIONED");
      console.log("  " + "-".repeat(90));
      for (const p of result.people) {
        const addr = p.address.length > 42 ? p.address.slice(0, 39) + "..." : p.address.padEnd(42);
        const name = (p.displayName ?? "").length > 22 ? (p.displayName ?? "").slice(0, 19) + "..." : (p.displayName ?? "").padEnd(22);
        console.log(`  ${addr}  ${name}  ${String(p.sentCount).padStart(5)}  ${String(p.receivedCount).padStart(5)}  ${String(p.mentionedCount).padStart(5)}`);
      }
      break;
    }

    case "thread": {
      let parsed;
      try {
        parsed = parseRawFlag(args, "zmail thread <thread_id> [--raw]");
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      const db = getDb();
      const threadId = normalizeMessageId(parsed.id);
      const messages = db
        .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY date ASC")
        .all(threadId) as MessageRow[];
      const shaped = await Promise.all(messages.map((m) => formatMessageForOutput(m, parsed.raw)));
      console.log(JSON.stringify(shaped, null, 2));
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
        console.log("null");
        break;
      }
      const shaped = await formatMessageForOutput(message, parsed.raw);
      console.log(formatMessageLlmFriendly(message, shaped));
      break;
    }

    case "refresh": {
      // Refresh: Frequent updates, brings local copy up to date
      // Usage: zmail refresh
      // No --since needed - uses last_uid checkpoint to fetch only new messages

      // Run sync (bandwidth-bound) and indexing (API-rate-bound) concurrently (ADR-020).
      let resolveSyncDone!: () => void;
      const syncDone = new Promise<void>((resolve) => { resolveSyncDone = resolve; });

      // Refresh always goes forward (fetches new messages since last sync)
      const syncOptions: { direction: 'forward'; onLogPath?: (logPath: string) => void } = {
        direction: 'forward',
      };
      
      // Print log path immediately when sync starts (useful for background execution)
      syncOptions.onLogPath = (logPath: string) => {
        console.log(`Sync log: ${logPath}`);
      };

      const syncPromise = runSync(syncOptions).then((result) => {
        resolveSyncDone();
        return result;
      });
      const indexPromise = indexMessages({ syncDone });

      // Wait for both to complete
      const [syncResult, indexResult] = await Promise.all([syncPromise, indexPromise]);

      // Log path already printed at start via onLogPath callback
      if (syncResult) {
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
      }

      if (indexResult.indexed > 0 || indexResult.failed > 0) {
        const sec = (indexResult.durationMs / 1000).toFixed(2);
        console.log("");
        console.log("Indexing metrics:");
        console.log(`  indexed:    ${indexResult.indexed}`);
        if (indexResult.failed > 0) {
          console.log(`  failed:     ${indexResult.failed}`);
        }
        console.log(`  throughput: ${Math.round(indexResult.messagesPerMinute)} msg/min`);
        console.log(`  duration:  ${sec}s`);
      }
      break;
    }

    case "status": {
      const db = getDb();
      const syncStatus = db.prepare("SELECT * FROM sync_summary WHERE id = 1").get() as {
        earliest_synced_date: string | null;
        latest_synced_date: string | null;
        total_messages: number;
        last_sync_at: string | null;
        is_running: number;
      };
      const indexStatus = db.prepare("SELECT * FROM indexing_status WHERE id = 1").get() as {
        is_running: number;
        total_to_index: number;
        indexed_so_far: number;
        started_at: string | null;
        completed_at: string | null;
      };

      // Sync status
      if (syncStatus.is_running) {
        console.log(`Sync:      running`);
      } else if (syncStatus.last_sync_at) {
        console.log(`Sync:      idle (last: ${syncStatus.last_sync_at.slice(0, 10)}, ${syncStatus.total_messages} messages)`);
      } else {
        console.log(`Sync:      never run`);
      }

      // Indexing status - always use messages table as source of truth
      const totalIndexed = db.prepare("SELECT COUNT(*) as count FROM messages WHERE embedding_state = 'done'").get() as { count: number };
      const totalFailed = db.prepare("SELECT COUNT(*) as count FROM messages WHERE embedding_state = 'failed'").get() as { count: number };
      const pendingCount = db.prepare("SELECT COUNT(*) as count FROM messages WHERE embedding_state = 'pending'").get() as { count: number };
      
      if (indexStatus.is_running) {
        // SQLite datetime('now') is UTC but has no 'Z'; parse as UTC to avoid negative elapsed (local-time parse)
        const startedMs = indexStatus.started_at
          ? (indexStatus.started_at.includes("Z") || indexStatus.started_at.includes("+")
              ? new Date(indexStatus.started_at).getTime()
              : new Date(indexStatus.started_at.replace(" ", "T") + "Z").getTime())
          : 0;
        const elapsed = startedMs ? Math.round((Date.now() - startedMs) / 1000) : 0;
        // total_to_index can be 0 when sync+index start together (pending was 0 at start); use live total for display
        const displayTotal = Math.max(indexStatus.total_to_index, indexStatus.indexed_so_far + pendingCount.count);
        console.log(`Indexing:  running (${indexStatus.indexed_so_far}/${displayTotal} indexed${totalFailed.count > 0 ? `, ${totalFailed.count} failed` : ''}, ${elapsed}s elapsed)`);
      } else if (indexStatus.completed_at) {
        console.log(`Indexing:  idle (last: ${indexStatus.completed_at.slice(0, 10)}, ${totalIndexed.count} indexed${totalFailed.count > 0 ? `, ${totalFailed.count} failed` : ''})`);
      } else {
        console.log(`Indexing:  never run`);
      }

      // Search readiness: use live counts (sync_summary.total_messages only updates when sync completes)
      const messagesCount = db.prepare("SELECT COUNT(*) as count FROM messages").get() as { count: number };
      const ftsCount = messagesCount.count;
      const semanticCount = totalIndexed.count;
      console.log(`Search:    FTS ready (${ftsCount}) | Semantic ready (${semanticCount})`);

      const dateRange = db.prepare("SELECT MIN(date) as earliest, MAX(date) as latest FROM messages").get() as {
        earliest: string | null;
        latest: string | null;
      };
      if (dateRange.earliest && dateRange.latest) {
        const earliest = dateRange.earliest.slice(0, 10);
        const latest = dateRange.latest.slice(0, 10);
        console.log(`Range:     ${earliest} .. ${latest}`);
      }
      break;
    }

    case "stats": {
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
      break;
    }

    case "attachment":
    case "attachments": {
      if (args.length === 0) {
        console.error("Usage: zmail attachment list <message_id>");
        console.error("       zmail attachment read <message_id> <index_or_filename> [--raw]");
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

        const isTty = process.stdout.isTTY;
        const shouldOutputJson = !isTty || args.includes("--json");

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
        const readArgs = args.filter((a) => a !== "--raw");
        const messageIdArg = readArgs[1];
        const indexOrFilename = readArgs[2];
        if (!messageIdArg || indexOrFilename === undefined) {
          console.error("Usage: zmail attachment read <message_id> <index_or_filename> [--raw]");
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
          // Extract and output text
          try {
            const { text } = await extractAndCache(absPath, attachment.mime_type, attachment.filename, attachment.id);
            console.log(text);
          } catch (err) {
            console.error(`Failed to extract attachment: ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
          }
        }
      } else {
        console.error(`Unknown subcommand: ${subcommand}`);
        console.error("Usage: zmail attachment list <message_id>");
        console.error("       zmail attachment read <message_id> <index_or_filename> [--raw]");
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
  zmail search <query> [flags]     Search email (see --help for flags)
  zmail who <query> [flags]        Find people by address or name (see --help for flags)
  zmail status                     Show sync and indexing status
  zmail stats                      Show database statistics
  zmail read <id> [--raw]          Read a message (or: zmail message <id>)
  zmail thread <id> [--raw]        Fetch thread (Markdown by default; raw .eml with --raw)
  zmail attachment list <message_id>   List attachments (use message_id from search)
  zmail attachment read <message_id> <index>|<filename>   Read by index (1-based) or filename
  zmail mcp                        Start MCP server (stdio)

Agent interfaces:
  CLI (this): Use for direct subprocess calls. Fast for one-off queries, returns JSON with --json flag.
  MCP: Use for persistent tool-based integration. Run 'zmail mcp' to start stdio server. See docs/MCP.md.

Run 'zmail setup' for setup instructions.
`);
    }
  }
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
