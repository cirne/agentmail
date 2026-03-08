import type { SqliteDatabase } from "~/db";
import { searchWithMeta } from "~/search";
import { who } from "~/search/who";
import { normalizeMessageId } from "~/mcp";
import { parseSinceToDate } from "~/sync/parse-since";

/**
 * Metadata-only search result (no body content).
 */
export interface MetadataSearchResult {
  messageId: string;
  threadId: string;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  date: string;
  snippet: string; // Short snippet only, no bodyPreview
  rank?: number; // FTS5 relevance rank (lower = more relevant)
}

/**
 * Parse relative date strings (e.g., "7d", "30d") to ISO dates.
 * Returns ISO date string if conversion succeeds, original string otherwise.
 */
function parseDateParam(dateStr: string | undefined): string | undefined {
  if (!dateStr) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr; // Already ISO format
  
  try {
    return parseSinceToDate(dateStr);
  } catch {
    // If parsing fails, leave as-is (might be invalid, search will handle)
    return dateStr;
  }
}

/**
 * Convert search results to metadata-only format (no body content).
 */
function toMetadataResults(
  results: Array<{ messageId: string; threadId: string; fromAddress: string; fromName: string | null; subject: string; date: string; snippet: string; rank?: number }>
): MetadataSearchResult[] {
  return results.map((r, index) => ({
    messageId: r.messageId,
    threadId: r.threadId,
    fromAddress: r.fromAddress,
    fromName: r.fromName,
    subject: r.subject,
    date: r.date,
    snippet: r.snippet || "",
    rank: r.rank !== undefined ? r.rank : index, // FTS5 rank if available, else position
  }));
}

/**
 * Add hints to response based on search results.
 */
function addSearchHints(response: any, totalMatched: number | undefined, resultCount: number, limit: number): void {
  if (totalMatched === undefined) return;

  if (totalMatched === 0) {
    response.hint = "No results found. Try different query terms, synonyms, or related keywords.";
  } else if (totalMatched > limit * 2) {
    response.hint = `Found ${totalMatched} total matches but only returned ${resultCount}. Consider increasing the limit or trying more specific query terms.`;
  } else if (totalMatched > limit) {
    response.hint = `Found ${totalMatched} total matches. Increase limit to see more results.`;
  }
}

/**
 * Check result diversity and add hint if results are too concentrated.
 */
function checkResultDiversity(response: any, metadataResults: MetadataSearchResult[]): void {
  if (metadataResults.length <= 5) return;

  const senderCounts = new Map<string, number>();
  for (const r of metadataResults) {
    senderCounts.set(r.fromAddress, (senderCounts.get(r.fromAddress) || 0) + 1);
  }
  
  const maxSenderCount = Math.max(...senderCounts.values());
  if (maxSenderCount / metadataResults.length > 0.8) {
    // 80%+ from same sender
    const topSender = [...senderCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (!response.hint) response.hint = "";
    response.hint += ` Most results are from ${topSender}. Consider searching with 'fromAddress' filter or trying different query terms for broader coverage.`;
  }
}

/**
 * Check if we have enough context based on result count and diversity.
 */
function checkEnoughContext(response: any, metadataResults: MetadataSearchResult[]): void {
  if (metadataResults.length < 20) return;

  const uniqueSenders = new Set(metadataResults.map((r) => r.fromAddress)).size;
  if (uniqueSenders >= 3 || metadataResults.length >= 50) {
    response.hasEnoughContext = true;
  }
}

/**
 * Check if search is too broad (many low-relevance results) and add hint.
 */
function checkSearchBroadness(response: any, metadataResults: MetadataSearchResult[]): void {
  if (metadataResults.length < 50) return;
  if (!metadataResults.some((r) => r.rank !== undefined)) return;

  const ranks = metadataResults.map((r) => r.rank || 0).filter((r) => r > 0);
  if (ranks.length === 0) return;

  const avgRank = ranks.reduce((a, b) => a + b, 0) / ranks.length;
  const maxRank = Math.max(...ranks);
  
  // If average rank is high (low relevance) or we have many low-relevance results
  if (avgRank > 10 || maxRank > 20) {
    response.hint = (response.hint || "") + ` Search returned many results but some have low relevance (average rank: ${avgRank.toFixed(1)}). Consider refining your query with more specific terms or filters.`;
  }
}

/**
 * Format thread results for response.
 */
function formatThreadResults(threads: Array<{ threadId: string; subject: string; messages: Array<{ messageId: string; fromAddress: string; fromName: string | null; subject: string; date: string }> }>): any {
  return threads.map((t) => ({
    threadId: t.threadId,
    subject: t.subject,
    messages: t.messages.map((m) => ({
      messageId: m.messageId,
      fromAddress: m.fromAddress,
      fromName: m.fromName,
      subject: m.subject,
      date: m.date,
    })),
  }));
}

/**
 * Execute search tool and return formatted response.
 */
async function executeSearchTool(
  db: SqliteDatabase,
  args: Record<string, unknown>
): Promise<string> {
  const query = args.query as string;
  const limit = (args.limit as number) ?? 50;
  const fromAddress = args.fromAddress as string | undefined;
  const toAddress = args.toAddress as string | undefined;
  const subject = args.subject as string | undefined;
  const afterDate = parseDateParam(args.afterDate as string | undefined);
  const beforeDate = parseDateParam(args.beforeDate as string | undefined);
  const includeThreads = (args.includeThreads as boolean) ?? false;

  const result = await searchWithMeta(db, {
    query,
    limit,
    fromAddress,
    toAddress,
    subject,
    afterDate,
    beforeDate,
    includeThreads,
  });

  const metadataResults = toMetadataResults(result.results);

  const response: any = {
    results: metadataResults,
    totalMatched: result.totalMatched,
  };

  addSearchHints(response, result.totalMatched, metadataResults.length, limit);
  checkResultDiversity(response, metadataResults);
  checkEnoughContext(response, metadataResults);
  checkSearchBroadness(response, metadataResults);

  return JSON.stringify({
    ...response,
    ...(result.threads && includeThreads
      ? { threads: formatThreadResults(result.threads) }
      : {}),
  });
}

/**
 * Execute who tool.
 */
async function executeWhoTool(
  db: SqliteDatabase,
  args: Record<string, unknown>
): Promise<string> {
  const query = args.query as string;
  const limit = (args.limit as number) ?? 10;

  const result = await who(db, {
    query,
    limit,
    includeNoreply: false,
    enrich: false, // No LLM enrichment for nano
  });

  return JSON.stringify(result);
}

/**
 * Execute get_thread_headers tool.
 */
function executeGetThreadHeadersTool(
  db: SqliteDatabase,
  args: Record<string, unknown>
): string {
  const threadId = args.threadId as string;
  const normalizedThreadId = normalizeMessageId(threadId);

  const rows = db
    .prepare(
      /* sql */ `
      SELECT message_id AS messageId, from_address AS fromAddress, from_name AS fromName,
             subject, date
      FROM messages
      WHERE thread_id = ?
      ORDER BY date ASC
    `
    )
    .all(normalizedThreadId) as Array<{
    messageId: string;
    fromAddress: string;
    fromName: string | null;
    subject: string;
    date: string;
  }>;

  if (rows.length === 0) {
    return JSON.stringify({ error: "Thread not found", threadId });
  }

  return JSON.stringify({
    threadId: normalizedThreadId,
    messages: rows,
  });
}

/**
 * Execute a nano tool (metadata-only).
 * Returns JSON string for the LLM.
 */
export async function executeNanoTool(
  db: SqliteDatabase,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    switch (name) {
      case "search":
        return await executeSearchTool(db, args);
      case "who":
        return await executeWhoTool(db, args);
      case "get_thread_headers":
        return executeGetThreadHeadersTool(db, args);
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get OpenAI tool definitions for nano (metadata-only tools).
 */
export function getNanoToolDefinitions() {
  return [
    {
      type: "function" as const,
      function: {
        name: "search",
        description:
          "Search emails by full-text and filters. Returns message list with headers/metadata only (messageId, threadId, from, subject, date, short snippet). No body content. Use from:, to:, after: in query or separate params.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Full-text search query. Supports inline operators: from:, to:, subject:, after:, before:",
            },
            limit: {
              type: "number",
              description: "Maximum number of results (default: 50). For sophisticated/complex queries requiring comprehensive coverage, use limit=100+. You have ~80k tokens available for metadata results total. Use 10-20 only for very specific, narrow searches.",
            },
            fromAddress: {
              type: "string",
              description: "Filter by sender email address",
            },
            toAddress: {
              type: "string",
              description: "Filter by recipient email address",
            },
            subject: {
              type: "string",
              description: "Filter by subject",
            },
            afterDate: {
              type: "string",
              description: "Filter messages after this date. Use relative dates like '7d' (7 days ago), '30d' (30 days ago), '1w' (1 week), '3m' (3 months), or ISO dates like '2024-01-01'",
            },
            beforeDate: {
              type: "string",
              description: "Filter messages before this date. Use relative dates like '7d', '30d', '1w', '3m' or ISO dates like '2024-01-01'",
            },
            includeThreads: {
              type: "boolean",
              description: "When true, also return full threads (headers only, no bodies)",
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "who",
        description:
          "Find people by email or display name. Returns addresses and contact stats (sent/received counts, last contact). Use to resolve 'who is X' or to get addresses before searching by sender.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query to match against email addresses or display names",
            },
            limit: {
              type: "number",
              description: "Maximum number of results (default: 10)",
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "get_thread_headers",
        description:
          "Get message headers in a thread by thread ID. Returns list of messages with messageId, from, subject, date only (no bodies). Use to see thread structure before fetching full content.",
        parameters: {
          type: "object",
          properties: {
            threadId: {
              type: "string",
              description: "Thread ID (from search results)",
            },
          },
          required: ["threadId"],
        },
      },
    },
  ];
}
