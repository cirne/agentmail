import { runSync } from "~/sync";
import { searchWithMeta, type SearchMode } from "~/search";
import { indexMessages } from "~/search/indexing";
import { getDb } from "~/db";
import { startMcpServer } from "~/mcp";
import { logger } from "~/lib/logger";
import { parseSinceToDate } from "~/sync/parse-since";
import { config } from "~/lib/config";
import { htmlToMarkdown, normalizePlainTextToMarkdown } from "~/lib/content-normalize";
import { parseRawMessage } from "~/sync/parse-message";
import type { SearchResult } from "~/lib/types";
import type { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";

const [, , command, ...args] = process.argv;

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
  console.error("  --from <address>   filter by sender email address");
  console.error("  --after <date>     filter by date (ISO YYYY-MM-DD or relative: 7d, 2w, 1m)");
  console.error("  --before <date>    filter by date (ISO YYYY-MM-DD or relative: 7d, 2w, 1m)");
  console.error("  --limit <n>        max results (default: 20)");
  console.error("  --mode <mode>      auto | fts | semantic | hybrid (default: auto)");
  console.error("  --detail <level>   headers | snippet | body (default: headers)");
  console.error("  --fields <csv>     projection fields, e.g. messageId,subject,date");
  console.error("  --ids-only         return only message IDs");
  console.error("  --timings          include machine-readable search timings");
  console.error("  --json             force JSON output (default: table for TTY, JSON when piped)");
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
  const hasFilters = !!(parsed.fromAddress || parsed.afterDate || parsed.beforeDate);
  if (!parsed.query && !hasFilters) {
    throw new Error("Provide a query and/or filters (--from, --after, --before).");
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

function hydrateBodies(db: Database, results: SearchResult[]): Array<SearchResult & { body: string }> {
  if (results.length === 0) return [];
  const ids = results.map((r) => r.messageId);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .query(
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

async function formatMessageForOutput(message: MessageRow, raw: boolean): Promise<Record<string, unknown>> {
  if (raw) {
    const rawEmail = readRawEmail(message.raw_path);
    return {
      ...message,
      content: {
        format: "raw",
        source: "eml",
        eml: rawEmail ? rawEmail.toString("utf8") : null,
      },
    };
  }

  const { body_text, ...rest } = message;
  let markdown = normalizePlainTextToMarkdown(body_text ?? "");
  let source: "body_text" | "html" | "text" | "empty" = markdown ? "body_text" : "empty";

  if (!markdown && message.raw_path) {
    const rawEmail = readRawEmail(message.raw_path);
    if (rawEmail) {
      try {
        const parsed = await parseRawMessage(rawEmail);
        if (parsed.bodyHtml) {
          markdown = htmlToMarkdown(parsed.bodyHtml);
          if (markdown) source = "html";
        }
        if (!markdown && parsed.bodyText) {
          markdown = normalizePlainTextToMarkdown(parsed.bodyText);
          if (markdown) source = "text";
        }
      } catch {
        // fall through to empty content
      }
    }
  }

  return {
    ...rest,
    content: {
      format: "markdown",
      source,
      markdown,
    },
  };
}

async function main() {
  switch (command) {
    case "sync": {
      const sinceIdx = args.indexOf("--since");
      const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;
      if (sinceIdx >= 0 && (since === undefined || since.startsWith("-"))) {
        console.error("Usage: zmail sync [--since <spec>]");
        console.error("  --since  relative range: 7d, 5w, 3m, 2y (days, weeks, months, years)");
        process.exit(1);
      }

      // Run sync (bandwidth-bound) and indexing (API-rate-bound) concurrently (ADR-020).
      // syncDone resolves when sync finishes inserting messages, signaling the indexer
      // to drain the queue and exit — regardless of whether sync found 0 or 1000 messages.
      let resolveSyncDone!: () => void;
      const syncDone = new Promise<void>((resolve) => { resolveSyncDone = resolve; });

      const syncPromise = runSync(since ? { since } : undefined).then((result) => {
        resolveSyncDone();
        return result;
      });
      const indexPromise = indexMessages({ syncDone });

      // Wait for both to complete
      const [syncResult, indexResult] = await Promise.all([syncPromise, indexPromise]);

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

    case "thread": {
      let parsed;
      try {
        parsed = parseRawFlag(args, "zmail thread <thread_id> [--raw]");
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      const db = getDb();
      const messages = db
        .query("SELECT * FROM messages WHERE thread_id = ? ORDER BY date ASC")
        .all(parsed.id) as MessageRow[];
      const shaped = await Promise.all(messages.map((m) => formatMessageForOutput(m, parsed.raw)));
      console.log(JSON.stringify(shaped, null, 2));
      break;
    }

    case "message": {
      let parsed;
      try {
        parsed = parseRawFlag(args, "zmail message <message_id> [--raw]");
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      const db = getDb();
      const message = db
        .query("SELECT * FROM messages WHERE message_id = ?")
        .get(parsed.id) as MessageRow | undefined;
      if (!message) {
        console.log("null");
        break;
      }
      const shaped = await formatMessageForOutput(message, parsed.raw);
      console.log(JSON.stringify(shaped, null, 2));
      break;
    }

    case "status": {
      const db = getDb();
      const syncStatus = db.query("SELECT * FROM sync_summary WHERE id = 1").get() as {
        earliest_synced_date: string | null;
        latest_synced_date: string | null;
        total_messages: number;
        last_sync_at: string | null;
        is_running: number;
      };
      const indexStatus = db.query("SELECT * FROM indexing_status WHERE id = 1").get() as {
        is_running: number;
        total_to_index: number;
        indexed_so_far: number;
        failed: number;
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

      // Indexing status
      if (indexStatus.is_running) {
        const elapsed = indexStatus.started_at
          ? Math.round((Date.now() - new Date(indexStatus.started_at).getTime()) / 1000)
          : 0;
        console.log(`Indexing:  running (${indexStatus.indexed_so_far}/${indexStatus.total_to_index} indexed, ${elapsed}s elapsed)`);
      } else if (indexStatus.completed_at) {
        console.log(`Indexing:  idle (last: ${indexStatus.completed_at.slice(0, 10)}, ${indexStatus.indexed_so_far} indexed)`);
      } else {
        console.log(`Indexing:  never run`);
      }

      // Search readiness
      const ftsCount = syncStatus.total_messages;
      // For semantic count, we check what's been indexed
      const semanticCount = indexStatus.indexed_so_far;
      console.log(`Search:    FTS ready (${ftsCount}) | Semantic ready (${semanticCount})`);
      break;
    }

    case "stats": {
      const db = getDb();
      const total = db.query("SELECT COUNT(*) as count FROM messages").get() as { count: number };
      const dateRange = db.query("SELECT MIN(date) as earliest, MAX(date) as latest FROM messages").get() as
        | { earliest: string | null; latest: string | null }
        | undefined;
      const topSenders = db
        .query(
          "SELECT from_address, COUNT(*) as count FROM messages GROUP BY from_address ORDER BY count DESC LIMIT 10"
        )
        .all() as Array<{ from_address: string; count: number }>;
      const folderBreakdown = db
        .query("SELECT folder, COUNT(*) as count FROM messages GROUP BY folder ORDER BY count DESC")
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

    case "mcp": {
      await startMcpServer();
      break;
    }

    default: {
      console.log(`zmail — agent-first email

Usage:
  zmail sync [--since <spec>]     Sync email + index embeddings (e.g. --since 7d, 5w, 3m, 2y)
  zmail search <query> [flags]    Search email (see --help for flags)
  zmail status                    Show sync and indexing status
  zmail stats                     Show database statistics
  zmail thread <id> [--raw]       Fetch thread (Markdown by default; raw .eml with --raw)
  zmail message <id> [--raw]      Fetch message (Markdown by default; raw .eml with --raw)
  zmail mcp                       Start MCP server (stdio)
`);
      if (command) {
        logger.error(`Unknown command: ${command}`);
        process.exit(1);
      }
    }
  }
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
