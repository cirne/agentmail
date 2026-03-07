import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join } from "path";
import { getDb } from "~/db";
import { search } from "~/search";
import { who } from "~/search/who";
import { logger } from "~/lib/logger";
import { extractAndCache } from "~/attachments";
import { config } from "~/lib/config";
import { getStatus, formatTimeAgo } from "~/lib/status";

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
 * - Searching emails with hybrid FTS5 + semantic search
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
    "Search emails using hybrid search (semantic + FTS5 full-text) by default. Returns matching messages with snippets. Supports inline query operators: from:, to:, subject:, after:, before:. Use fts=true for FTS-only (exact keyword matching). Example: 'invoice from:alice@example.com after:30d'",
    {
      query: z.string().optional().describe("Full-text search query. Supports inline operators: from:, to:, subject:, after:, before:. Example: 'invoice from:alice@example.com after:30d'"),
      limit: z.number().optional().describe("Maximum number of results to return (default: 20)"),
      offset: z.number().optional().describe("Pagination offset for skipping results (default: 0)"),
      fromAddress: z.string().optional().describe("Filter by sender email address (alternative to 'from:' in query)"),
      afterDate: z.string().optional().describe("Filter messages after this date. ISO 8601 format or relative (e.g., '7d', '30d', '2024-01-01')"),
      beforeDate: z.string().optional().describe("Filter messages before this date. ISO 8601 format or relative (e.g., '7d', '30d', '2024-01-01')"),
      fts: z.boolean().optional().describe("If true, use FTS-only search (exact keyword matching). Default is false (hybrid search: semantic + FTS)"),
    },
    async ({ query, limit, offset, fromAddress, afterDate, beforeDate, fts }) => {
      const db = getDb();
      const results = await search(db, {
        query,
        limit,
        offset,
        fromAddress,
        afterDate,
        beforeDate,
        fts,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
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
      const db = getDb();
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
      const db = getDb();
      const attachment = db
        .prepare("SELECT id, message_id, filename, mime_type, size, stored_path FROM attachments WHERE id = ?")
        .get(attachmentId) as
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
    "Retrieve a single message by message ID. Returns message content in LLM-friendly formatted text (headers, body, attachments list). Use raw=true to get the original EML format instead.",
    {
      messageId: z.string().describe("Message ID (from search_mail results) to retrieve"),
      raw: z.boolean().optional().describe("If true, return raw EML format instead of parsed/formatted content (default: false)"),
    },
    async ({ messageId, raw = false }) => {
      const db = getDb();
      const { formatMessageForOutput } = await import("~/cli");
      const { formatMessageLlmFriendly } = await import("~/cli/format-message");
      
      const message = db
        .prepare("SELECT * FROM messages WHERE message_id = ?")
        .get(messageId) as any | undefined;
      
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
      
      const shaped = await formatMessageForOutput(message, raw);
      const formatted = formatMessageLlmFriendly(message, shaped);
      
      return {
        content: [
          {
            type: "text",
            text: formatted,
          },
        ],
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
      const db = getDb();
      const { formatMessageForOutput } = await import("~/cli");
      
      const normalizedThreadId = normalizeMessageId(threadId);
      const messages = db
        .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY date ASC")
        .all(normalizedThreadId) as any[];
      
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
      
      const shaped = await Promise.all(messages.map((m) => formatMessageForOutput(m, raw)));
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(shaped, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "who",
    "Find people by email address or display name. Returns merged identities with contact info, sent/received/mentioned counts. Useful for 'who is X?' queries.",
    {
      query: z.string().describe("Search query to match against email addresses or display names"),
      limit: z.number().optional().describe("Maximum number of results to return (default: 50)"),
      minSent: z.number().optional().describe("Minimum sent count filter (default: 0)"),
      minReceived: z.number().optional().describe("Minimum received count filter (default: 0)"),
      includeNoreply: z.boolean().optional().describe("Include noreply/bot addresses (default: false)"),
      enrich: z.boolean().optional().describe("Use LLM (GPT-4.1 nano) to guess names from email addresses for better accuracy. Requires ZMAIL_OPENAI_API_KEY to be set. Adds ~1-2s latency (default: false)"),
    },
    async ({ query, limit, minSent, minReceived, includeNoreply, enrich }) => {
      const db = getDb();
      const ownerAddress = config.imap.user?.trim() || undefined;
      const result = await who(db, {
        query,
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
    "Get sync and indexing status. Returns current state of sync (running/idle, last sync time, message count), indexing progress, search readiness (FTS/semantic counts), date range of synced messages, and freshness (time since latest mail and last sync, human + ISO 8601 duration).",
    {},
    async () => {
      const status = getStatus();
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
