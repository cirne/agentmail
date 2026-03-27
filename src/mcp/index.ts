import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join } from "path";
import { getDb } from "~/db";
import { searchWithMeta } from "~/search";
import {
  resolveSearchJsonFormat,
  searchResultToSlimJsonRow,
  searchSlimResultHint,
  type SearchResultFormatPreference,
} from "~/search/search-json-format";
import { who } from "~/search/who";
import { logger } from "~/lib/logger";
import { extractAndCache } from "~/attachments";
import { listAttachmentsForMessage } from "~/attachments/list-for-message";
import { config } from "~/lib/config";
import { getStatus, formatTimeAgo } from "~/lib/status";
import {
  DEFAULT_BODY_CAP,
  DEFAULT_MAX_BODY_CHARS,
  shapeShapedToOutput,
  type ShapedMessageLike,
} from "~/messages/lean-shape";
import { resolveGetMessagesShapeDetail } from "./get-messages-detail";
import {
  sendSimpleMessage,
  sendDraftById,
  writeDraft,
  readDraft,
  listDrafts,
  createDraftId,
  archiveDraftToSent,
  type DraftFrontmatter,
} from "~/send";

/** Param keys for send_email MCP tool — keep in sync with schema. */
export const MCP_SEND_EMAIL_PARAM_KEYS: readonly string[] = [
  "to",
  "cc",
  "bcc",
  "subject",
  "body",
  "dryRun",
];

/** Param keys for create_draft MCP tool. */
export const MCP_CREATE_DRAFT_PARAM_KEYS: readonly string[] = [
  "kind",
  "to",
  "cc",
  "bcc",
  "subject",
  "body",
  "sourceMessageId",
  "forwardOf",
];

/** Param keys for send_draft MCP tool. */
export const MCP_SEND_DRAFT_PARAM_KEYS: readonly string[] = ["draftId", "dryRun"];

/**
 * Param keys for search_mail tool. Used by CLI/MCP sync test; keep in sync with the tool schema and SearchOptions.
 */
export const MCP_SEARCH_MAIL_PARAM_KEYS: readonly string[] = [
  "query",
  "limit",
  "offset",
  "fromAddress",
  "afterDate",
  "beforeDate",
  "includeThreads",
  "includeNoise",
  "resultFormat",
];

/**
 * Param keys for who tool. Used by CLI/MCP sync test; keep in sync with the tool schema and WhoOptions.
 */
export const MCP_WHO_PARAM_KEYS: readonly string[] = [
  "query",
  "limit",
  "minSent",
  "minReceived",
  "includeNoreply",
  "enrich",
];

/**
 * Normalizes a message/thread ID to ensure it's wrapped in angle brackets.
 */
export function normalizeMessageId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return id;
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed;
  return `<${trimmed}>`;
}

/**
 * Creates an MCP server exposing zmail's email search and retrieval capabilities.
 * 
 * The server runs in stdio-only mode (no HTTP, no ports) and provides tools for:
 * - Searching emails with FTS5 full-text search
 * - Retrieving individual messages and threads
 * - Finding people by email/name
 * - Getting sync/indexing status and statistics
 * - Listing and reading attachments
 * 
 * All tools operate on the same SQLite database used by CLI commands.
 * 
 * @see {@link https://modelcontextprotocol.io} MCP specification
 * @see {@link ../docs/MCP.md} MCP server documentation
 */
export function createMcpServer() {
  const server = new McpServer({
    name: "zmail",
    version: "0.1.0",
  });

  server.tool(
    "search_mail",
    "Search emails using FTS5 full-text search. Response object: results, returned, totalMatched, format (slim|full), optional hint, threads, timings. With resultFormat auto (default), more than 50 results use slim rows; use get_messages for bodyPreview. resultFormat full forces full rows.",
    {
      query: z.string().optional().describe("Full-text search query. Supports inline operators: from:, to:, subject:, after:, before:. Example: 'invoice from:alice@example.com after:30d'"),
      limit: z.number().optional().describe("Maximum number of results to return (default: all matches)"),
      offset: z.number().optional().describe("Pagination offset for skipping results (default: 0)"),
      fromAddress: z.string().optional().describe("Filter by sender email address (alternative to 'from:' in query)"),
      afterDate: z.string().optional().describe("Filter messages after this date. ISO 8601 format or relative (e.g., '7d', '30d', '2024-01-01')"),
      beforeDate: z.string().optional().describe("Filter messages before this date. ISO 8601 format or relative (e.g., '7d', '30d', '2024-01-01')"),
      includeThreads: z.boolean().optional().describe("When true, also return full threads (all messages per matching thread) to avoid get_thread calls (default: false)"),
      includeNoise: z.boolean().optional().describe("When true, includes noise messages (promotional, social, forums, bulk, spam) in results (Gmail categories: Promotions, Social, Forums, Spam). Defaults to false."),
      resultFormat: z
        .enum(["auto", "full", "slim"])
        .optional()
        .describe(
          "Row shape: auto (default) uses slim rows when more than 50 results; full = always bodyPreview + metadata; slim = always triage-only rows"
        ),
    },
    async ({ query, limit, offset, fromAddress, afterDate, beforeDate, includeThreads, includeNoise, resultFormat }) => {
      const db = await getDb();
      const result = await searchWithMeta(db, {
        query,
        limit,
        offset,
        fromAddress,
        afterDate,
        beforeDate,
        includeThreads: includeThreads ?? false,
        includeNoise: includeNoise ?? false,
        ownerAddress: config.imap.user?.trim() || undefined,
      });

      const preference = (resultFormat ?? "auto") as SearchResultFormatPreference;
      const fmt = resolveSearchJsonFormat({
        resultCount: result.results.length,
        preference,
        allowAutoSlim: true,
      });
      const rows =
        fmt === "slim"
          ? result.results.map((r) => searchResultToSlimJsonRow(r))
          : (result.results as unknown as Record<string, unknown>[]);

      const payload: Record<string, unknown> = {
        results: rows,
        returned: rows.length,
        totalMatched: result.totalMatched ?? rows.length,
        format: fmt,
        ...(fmt === "slim" ? { hint: searchSlimResultHint() } : {}),
        ...(result.threads?.length ? { threads: result.threads } : {}),
        ...(result.timings ? { timings: result.timings } : {}),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    }
  );

  server.tool(
    "list_attachments",
    "List attachments for a message. Returns array of attachment metadata including ID, filename, MIME type, size, and extraction status. Use the attachment ID from this response with read_attachment to extract content.",
    {
      messageId: z.string().describe("Message ID (from search_mail results) to list attachments for"),
    },
    async ({ messageId }) => {
      const db = await getDb();
      const normalizedId = normalizeMessageId(messageId);
      const attachments = await listAttachmentsForMessage(db, normalizedId);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              attachments.map((a) => ({
                id: a.id,
                filename: a.filename,
                mimeType: a.mime_type,
                size: a.size,
                extracted: a.extracted_text !== null,
              })),
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "read_attachment",
    "Read and extract an attachment to text. Returns markdown for PDFs/DOCX, CSV for spreadsheets (XLSX), or plain text. Extraction happens on first call and is cached. Supported formats: PDF, DOCX, XLSX, HTML, CSV, TXT.",
    {
      attachmentId: z.number().describe("Attachment ID (from list_attachments results) to read and extract"),
    },
    async ({ attachmentId }) => {
      const db = await getDb();
      const attachment = (await (
        await db.prepare("SELECT id, message_id, filename, mime_type, size, stored_path FROM attachments WHERE id = ?")
      ).get(attachmentId)) as
        | {
            id: number;
            message_id: string;
            filename: string;
            mime_type: string;
            size: number;
            stored_path: string;
          }
        | undefined;

      if (!attachment) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `Attachment ${attachmentId} not found` }, null, 2),
            },
          ],
        };
      }

      try {
        const absPath = join(config.maildirPath, attachment.stored_path);
        const { text } = await extractAndCache(absPath, attachment.mime_type, attachment.filename, attachment.id);
        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { error: `Failed to extract attachment: ${err instanceof Error ? err.message : String(err)}` },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  server.tool(
    "get_message",
    "Retrieve a single message by message ID. Returns the same JSON shape as one element of get_messages (same params: detail, maxBodyChars). Use detail: 'summary' for minimal payload, detail: 'full' (default) for body up to maxBodyChars, or raw=true / detail: 'raw' for EML. For reading multiple messages, use get_messages instead to batch-read in a single call.",
    {
      messageId: z.string().describe("Message ID (from search_mail results) to retrieve"),
      raw: z.boolean().optional().describe("If true, return raw EML (same as detail: 'raw'). Prefer detail: 'raw' instead."),
      detail: z.enum(["full", "summary", "raw"]).optional().describe("'summary' = minimal + 200-char snippet; 'full' = body up to maxBodyChars (default); 'raw' = EML. Same as get_messages."),
      maxBodyChars: z.number().optional().describe("When detail is 'full': max body chars (default 2000). Same as get_messages. Ignored for 'summary' or 'raw'."),
    },
    async ({ messageId, raw = false, detail, maxBodyChars = DEFAULT_MAX_BODY_CHARS }) => {
      const db = await getDb();
      const { formatMessageForOutput } = await import("~/messages/presenter");

      const normalizedId = normalizeMessageId(messageId);
      const message = (await (await db.prepare("SELECT * FROM messages WHERE message_id = ?")).get(normalizedId)) as
        | any
        | undefined;

      if (!message) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `Message ${messageId} not found` }, null, 2),
            },
          ],
        };
      }

      const useRaw = raw || detail === "raw";
      const shaped = await formatMessageForOutput(message, useRaw, db);
      const out = shapeShapedToOutput([shaped], { useRaw, detail, maxBodyChars });
      return {
        content: [{ type: "text", text: JSON.stringify(out[0], null, 2) }],
      };
    }
  );

  server.tool(
    "get_messages",
    "Batch-read multiple emails in one call (max 20). If you omit detail and request more than 5 message IDs, all results are returned in summary form (subject, from, to, date, 200-char snippet) to save tokens. Pass detail: 'full' to force full bodies for any batch size. detail: 'summary' always uses the slim shape; detail: 'raw' / raw=true returns EML.",
    {
      messageIds: z.array(z.string()).describe("Array of message IDs (from search_mail results) to retrieve"),
      detail: z.enum(["full", "summary", "raw"]).optional().describe("'summary' = minimal payload; 'full' = body up to maxBodyChars; 'raw' = EML. Omit detail: batches of 6+ IDs default to summary; use 'full' to override."),
      raw: z.boolean().optional().describe("If true, return raw EML (same as detail: 'raw'). Prefer detail: 'raw' instead."),
      maxBodyChars: z.number().optional().describe("When effective detail is 'full': max body chars per message (default 2000). Ignored for summary or raw."),
    },
    async ({ messageIds, detail, raw = false, maxBodyChars = DEFAULT_MAX_BODY_CHARS }) => {
      const db = await getDb();
      const { formatMessageForOutput } = await import("~/messages/presenter");
      const useRaw = raw || detail === "raw";

      const cappedIds = messageIds.slice(0, 20);
      const shapeDetail = resolveGetMessagesShapeDetail(cappedIds.length, detail, raw);
      const normalizedIds = cappedIds.map((id) => normalizeMessageId(id));

      const placeholders = normalizedIds.map(() => "?").join(",");
      const rows = (await (
        await db.prepare(`SELECT * FROM messages WHERE message_id IN (${placeholders})`)
      ).all(...normalizedIds)) as any[];
      const byMessageId = new Map(rows.map((m) => [m.message_id as string, m]));
      const messages = normalizedIds.map((id) => byMessageId.get(id)).filter(Boolean) as any[];

      if (messages.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "No messages found", requested: messageIds.length, found: 0 }, null, 2),
            },
          ],
        };
      }

      const shaped = await Promise.all(messages.map((m) => formatMessageForOutput(m, useRaw, db)));
      const out = shapeShapedToOutput(shaped, { useRaw, detail: shapeDetail, maxBodyChars });
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      };
    }
  );

  server.tool(
    "get_thread",
    "Retrieve a full conversation thread by thread ID. Returns all messages in the thread ordered by date. Use raw=true to get original EML format for each message.",
    {
      threadId: z.string().describe("Thread ID (from search_mail or get_message results) to retrieve"),
      raw: z.boolean().optional().describe("If true, return raw EML format for each message instead of parsed/formatted content (default: false)"),
    },
    async ({ threadId, raw = false }) => {
      const db = await getDb();
      const { formatMessageForOutput } = await import("~/messages/presenter");

      const normalizedThreadId = normalizeMessageId(threadId);
      const messages = (await (
        await db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY date ASC")
      ).all(normalizedThreadId)) as any[];
      
      if (messages.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: `Thread ${threadId} not found` }, null, 2),
            },
          ],
        };
      }
      
      const shaped = await Promise.all(messages.map((m) => formatMessageForOutput(m, raw, db)));

      if (raw) {
        return {
          content: [{ type: "text", text: JSON.stringify(shaped, null, 2) }],
        };
      }
      const out = shapeShapedToOutput(shaped as (ShapedMessageLike | Record<string, unknown>)[], { useRaw: false, detail: "full", maxBodyChars: DEFAULT_BODY_CAP });
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      };
    }
  );

  server.tool(
    "who",
    "Find people by email address or display name. Returns merged identities with contact info, sent/received/mentioned counts. Omit query (or empty string) to list top contacts by mailbox activity / contact rank (indexed-mail signal, not personal worth). Useful for 'who is X?' or address-book style listings.",
    {
      query: z
        .string()
        .optional()
        .describe(
          "Substring match on address or display name; omit or leave empty for top contacts (ordered by contact rank when owner is configured)"
        ),
      limit: z.number().optional().describe("Maximum number of results to return (default: 50)"),
      minSent: z.number().optional().describe("Minimum sent count filter (default: 0)"),
      minReceived: z.number().optional().describe("Minimum received count filter (default: 0)"),
      includeNoreply: z.boolean().optional().describe("Include noreply/bot addresses (default: false)"),
      enrich: z.boolean().optional().describe("Use LLM (GPT-4.1 nano) to guess names from email addresses for better accuracy. Requires ZMAIL_OPENAI_API_KEY to be set. Adds ~1-2s latency (default: false)"),
    },
    async ({ query, limit, minSent, minReceived, includeNoreply, enrich }) => {
      const db = await getDb();
      const ownerAddress = config.imap.user?.trim() || undefined;
      const result = await who(db, {
        query: query ?? "",
        limit,
        minSent,
        minReceived,
        includeNoreply,
        ownerAddress,
        enrich,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_status",
    "Get sync and indexing status. Returns current state of sync (running/idle, last sync time, message count), indexing progress, search readiness (FTS count), date range of synced messages, and freshness (time since latest mail and last sync, human + ISO 8601 duration).",
    {},
    async () => {
      const status = await getStatus();
      const latestMailAgo = formatTimeAgo(status.dateRange?.latest ?? null);
      const lastSyncAgo = status.sync.isRunning ? null : formatTimeAgo(status.sync.lastSyncAt);
      const output = {
        ...status,
        freshness: {
          latestMailAgo: latestMailAgo ?? null,
          lastSyncAgo: lastSyncAgo ?? null,
        },
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(output, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_stats",
    "Get database statistics. Returns total message count, date range, top senders (top 10), and messages by folder breakdown.",
    {},
    async () => {
      const db = await getDb();
      const total = (await (await db.prepare("SELECT COUNT(*) as count FROM messages")).get()) as { count: number };
      const dateRange = (await (
        await db.prepare("SELECT MIN(date) as earliest, MAX(date) as latest FROM messages")
      ).get()) as { earliest: string | null; latest: string | null } | undefined;
      const topSenders = (await (
        await db.prepare(
          "SELECT from_address, COUNT(*) as count FROM messages GROUP BY from_address ORDER BY count DESC LIMIT 10"
        )
      ).all()) as Array<{ from_address: string; count: number }>;
      const folderBreakdown = (await (
        await db.prepare("SELECT folder, COUNT(*) as count FROM messages GROUP BY folder ORDER BY count DESC")
      ).all()) as Array<{ folder: string; count: number }>;

      const result = {
        totalMessages: total.count,
        dateRange: dateRange?.earliest && dateRange?.latest
          ? {
              earliest: dateRange.earliest,
              latest: dateRange.latest,
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
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "send_email",
    "Send a plain-text email via SMTP (same credentials as IMAP). Dev/test: only lewiscirne+zmail@gmail.com unless ZMAIL_SEND_PRODUCTION=1. Returns ok, messageId, smtpResponse.",
    {
      to: z.union([z.string(), z.array(z.string())]).describe("Recipient(s) — comma-separated or array"),
      subject: z.string().describe("Subject line"),
      body: z.string().describe("Plain-text body"),
      cc: z.union([z.string(), z.array(z.string())]).optional().describe("Optional CC addresses"),
      bcc: z.union([z.string(), z.array(z.string())]).optional().describe("Optional BCC addresses"),
      dryRun: z.boolean().optional().describe("If true, validate only — do not send"),
    },
    async ({ to, subject, body, cc, bcc, dryRun }) => {
      const norm = (v: string | string[] | undefined): string[] | undefined => {
        if (v == null) return undefined;
        if (Array.isArray(v)) return v;
        return v
          .split(/[,;]/)
          .map((x) => x.trim())
          .filter(Boolean);
      };
      const toList = norm(to as string | string[]) ?? [];
      if (toList.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "to is required" }) }] };
      }
      const result = await sendSimpleMessage(
        {
          to: toList,
          cc: norm(cc as string | string[] | undefined),
          bcc: norm(bcc as string | string[] | undefined),
          subject,
          text: body,
        },
        { dryRun: dryRun ?? false }
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "create_draft",
    "Create a local draft (Markdown+YAML under data/drafts/). Does not sync to provider Drafts folder. Returns id and full draft fields.",
    {
      kind: z.enum(["new", "reply", "forward"]).describe("Draft type"),
      to: z.union([z.string(), z.array(z.string())]).optional().describe("Recipients (required for new/forward; reply defaults to original sender)"),
      subject: z.string().optional().describe("Subject"),
      body: z.string().optional().describe("Body text"),
      sourceMessageId: z
        .string()
        .optional()
        .describe("For reply: Message-ID of the message being replied to (from search/read)"),
      forwardOf: z.string().optional().describe("For forward: Message-ID of forwarded message"),
    },
    async ({ kind, to, subject, body, sourceMessageId, forwardOf }) => {
      const dataDir = config.dataDir;
      const normTo = (v: string | string[] | undefined): string[] => {
        if (v == null) return [];
        if (Array.isArray(v)) return v;
        return v
          .split(/[,;]/)
          .map((x) => x.trim())
          .filter(Boolean);
      };
      const db = await getDb();
      let fm: DraftFrontmatter;
      const textBody = body ?? "";

      if (kind === "new") {
        const toList = normTo(to as string | string[] | undefined);
        if (toList.length === 0 || !subject) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ error: "new draft requires to and subject" }) },
            ],
          };
        }
        fm = { kind: "new", to: toList, subject };
      } else if (kind === "reply") {
        if (!sourceMessageId) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "reply requires sourceMessageId" }) }],
          };
        }
        const row = (await (
          await db.prepare(
            "SELECT message_id, from_address, subject, thread_id FROM messages WHERE message_id = ?"
          )
        ).get(normalizeMessageId(sourceMessageId))) as
          | { message_id: string; from_address: string; subject: string; thread_id: string }
          | undefined;
        if (!row) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "message not found" }) }],
          };
        }
        const toList = to ? normTo(to as string | string[]) : [row.from_address];
        const subj = subject ?? (row.subject.startsWith("Re:") ? row.subject : `Re: ${row.subject}`);
        fm = {
          kind: "reply",
          to: toList,
          subject: subj,
          sourceMessageId: row.message_id,
          threadId: row.thread_id,
        };
      } else {
        if (!forwardOf || !to) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ error: "forward requires forwardOf and to" }) },
            ],
          };
        }
        const row = (await (
          await db.prepare("SELECT message_id, subject, thread_id FROM messages WHERE message_id = ?")
        ).get(normalizeMessageId(forwardOf))) as
          | { message_id: string; subject: string; thread_id: string }
          | undefined;
        if (!row) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "message not found" }) }],
          };
        }
        const subj = subject ?? `Fwd: ${row.subject}`;
        fm = {
          kind: "forward",
          to: normTo(to as string | string[]),
          subject: subj,
          forwardOf: row.message_id,
          threadId: row.thread_id,
        };
      }

      const id = createDraftId();
      writeDraft(dataDir, id, fm, textBody);
      const d = readDraft(dataDir, id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ id: d.id, ...d.frontmatter, body: d.body }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "send_draft",
    "Send a draft created with create_draft (SMTP). Archives the draft file to data/sent/ on success. Same dev allowlist as send_email.",
    {
      draftId: z.string().describe("Draft id returned by create_draft"),
      dryRun: z.boolean().optional().describe("If true, validate only"),
    },
    async ({ draftId, dryRun }) => {
      const db = await getDb();
      const result = await sendDraftById(draftId, {
        dryRun: dryRun ?? false,
        db,
        dataDir: config.dataDir,
        maildirPath: config.maildirPath,
      });
      if (!dryRun && result.ok) {
        archiveDraftToSent(config.dataDir, draftId);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "list_drafts",
    "List local drafts (ids, kind, subject).",
    {},
    async () => {
      const rows = listDrafts(config.dataDir);
      return {
        content: [{ type: "text", text: JSON.stringify({ drafts: rows }, null, 2) }],
      };
    }
  );

  return server;
}

/**
 * Starts the MCP server on stdio (stdin/stdout).
 * 
 * The server communicates via JSON-RPC over stdio and runs until:
 * - stdin closes (EOF)
 * - Process is terminated (SIGTERM/SIGINT)
 * 
 * This is the stdio-only mode — no HTTP server, no port management.
 * Designed for local agent integration where the agent spawns this process
 * and communicates over stdio.
 * 
 * @example
 * ```bash
 * zmail mcp
 * ```
 * 
 * Or configure in your MCP client (e.g., Claude Desktop):
 * ```json
 * {
 *   "mcpServers": {
 *     "zmail": {
 *       "command": "zmail",
 *       "args": ["mcp"]
 *     }
 *   }
 * }
 * ```
 */
export async function startMcpServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server running on stdio");
}
