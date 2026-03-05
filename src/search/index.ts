import type { Database } from "bun:sqlite";
import type { SearchResult } from "~/lib/types";
import { embedText } from "./embeddings";
import { searchVectors } from "./vectors";

export type SearchMode = "auto" | "fts" | "semantic" | "hybrid";
export type ResolvedSearchMode = "filter" | "fts" | "semantic" | "hybrid";

export interface SearchOptions {
  query?: string;
  limit?: number;
  offset?: number;
  fromAddress?: string;
  afterDate?: string;
  beforeDate?: string;
  mode?: SearchMode;
}

export interface SearchTimings {
  ftsMs?: number;
  embedMs?: number;
  vectorMs?: number;
  mergeMs?: number;
  totalMs: number;
  modeUsed: ResolvedSearchMode;
}

export interface SearchResultSet {
  results: SearchResult[];
  timings: SearchTimings;
}

/** LIKE pattern for partial match on address or display name (e.g. "donna" -> "%donna%"). */
function fromFilterPattern(value: string): string {
  return `%${value}%`;
}

/**
 * Filter-only search (no query text, just WHERE clauses).
 */
function filterOnlySearch(db: Database, opts: SearchOptions): SearchResult[] {
  const { limit = 20, offset = 0, fromAddress, afterDate, beforeDate } = opts;
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (fromAddress) {
    const pattern = fromFilterPattern(fromAddress);
    conditions.push("(m.from_address LIKE ? OR m.from_name LIKE ?)");
    params.push(pattern, pattern);
  }
  if (afterDate) {
    conditions.push("m.date >= ?");
    params.push(afterDate);
  }
  if (beforeDate) {
    conditions.push("m.date <= ?");
    params.push(beforeDate);
  }

  params.push(limit, offset);
  const where = `WHERE ${conditions.join(" AND ")}`;
  const rows = db
    .query(
      /* sql */ `
      SELECT
        m.message_id   AS messageId,
        m.thread_id    AS threadId,
        m.from_address AS fromAddress,
        m.from_name    AS fromName,
        m.subject,
        m.date,
        COALESCE(TRIM(SUBSTR(m.body_text, 1, 200)), '') || (CASE WHEN LENGTH(m.body_text) > 200 THEN '…' ELSE '' END) AS snippet,
        0 AS rank
      FROM messages m
      ${where}
      ORDER BY m.date DESC
      LIMIT ? OFFSET ?
    `
    )
    .all(...params) as SearchResult[];
  return rows;
}

/**
 * FTS5 search (keyword matching via BM25).
 */
function ftsSearch(db: Database, opts: SearchOptions): SearchResult[] {
  const { query, limit = 20, offset = 0, fromAddress, afterDate, beforeDate } = opts;
  if (!query?.trim()) return [];

  const conditions: string[] = ["messages_fts MATCH ?"];
  const params: (string | number)[] = [query];

  if (fromAddress) {
    const pattern = fromFilterPattern(fromAddress);
    conditions.push("(m.from_address LIKE ? OR m.from_name LIKE ?)");
    params.push(pattern, pattern);
  }
  if (afterDate) {
    conditions.push("m.date >= ?");
    params.push(afterDate);
  }
  if (beforeDate) {
    conditions.push("m.date <= ?");
    params.push(beforeDate);
  }

  params.push(limit + offset + 50);

  const rows = db
    .query(
      /* sql */ `
      SELECT
        m.message_id  AS messageId,
        m.thread_id   AS threadId,
        m.from_address AS fromAddress,
        m.from_name   AS fromName,
        m.subject,
        m.date,
        snippet(messages_fts, 2, '<b>', '</b>', '…', 20) AS snippet,
        rank
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      WHERE ${conditions.join(" AND ")}
      ORDER BY rank
      LIMIT ?
    `
    )
    .all(...params) as SearchResult[];

  // Apply filters and limit/offset
  let filtered = rows;
  if (fromAddress || afterDate || beforeDate) {
    filtered = rows.filter((r) => {
      if (fromAddress) {
        const pattern = fromAddress.toLowerCase();
        const fromMatch =
          r.fromAddress.toLowerCase().includes(pattern) ||
          (r.fromName && r.fromName.toLowerCase().includes(pattern));
        if (!fromMatch) return false;
      }
      if (afterDate && r.date < afterDate) return false;
      if (beforeDate && r.date > beforeDate) return false;
      return true;
    });
  }

  return filtered.slice(offset, offset + limit);
}

/**
 * Semantic/vector search.
 */
async function vectorSearchFromEmbedding(
  db: Database,
  opts: SearchOptions,
  queryEmbedding: number[]
): Promise<SearchResult[]> {
  const { query, limit = 20, offset = 0, fromAddress, afterDate, beforeDate } = opts;
  if (!query?.trim()) return [];

  // Search LanceDB for similar messages
  const vectorResults = await searchVectors(queryEmbedding, limit + offset + 50); // Get extra for filtering

  // Fetch full message details from SQLite and apply filters
  const messageIds = vectorResults.map((r) => r.messageId);
  if (messageIds.length === 0) return [];

  const placeholders = messageIds.map(() => "?").join(",");
  const conditions: string[] = [`m.message_id IN (${placeholders})`];
  const params: (string | number)[] = [...messageIds];

  if (fromAddress) {
    const pattern = fromFilterPattern(fromAddress);
    conditions.push("(m.from_address LIKE ? OR m.from_name LIKE ?)");
    params.push(pattern, pattern);
  }
  if (afterDate) {
    conditions.push("m.date >= ?");
    params.push(afterDate);
  }
  if (beforeDate) {
    conditions.push("m.date <= ?");
    params.push(beforeDate);
  }

  // Fetch messages and preserve vector search order
  const messages = db
    .query(
      /* sql */ `
      SELECT
        m.message_id  AS messageId,
        m.thread_id   AS threadId,
        m.from_address AS fromAddress,
        m.from_name   AS fromName,
        m.subject,
        m.date,
        m.body_text   AS bodyText
      FROM messages m
      WHERE ${conditions.join(" AND ")}
    `
    )
    .all(...params) as Array<SearchResult & { bodyText: string }>;

  // Create a map of messageId -> vector score for ranking
  const scoreMap = new Map(vectorResults.map((r) => [r.messageId, r.score]));

  // Sort by vector score (highest first), then apply limit/offset
  const sorted = messages
    .map((m) => ({
      ...m,
      rank: scoreMap.get(m.messageId) ?? 0,
      snippet: generateSnippet(m.bodyText, query), // Simple snippet generation
    }))
    .sort((a, b) => b.rank - a.rank)
    .slice(offset, offset + limit);

  return sorted.map(({ bodyText, ...rest }) => rest);
}

async function vectorSearch(db: Database, opts: SearchOptions): Promise<SearchResult[]> {
  const { query } = opts;
  if (!query?.trim()) return [];
  const queryEmbedding = await embedText(query);
  return vectorSearchFromEmbedding(db, opts, queryEmbedding);
}

interface VectorSearchRun {
  results: SearchResult[];
  embedMs: number;
  vectorMs: number;
}

async function vectorSearchWithTimings(
  db: Database,
  opts: SearchOptions
): Promise<VectorSearchRun> {
  const { query } = opts;
  if (!query?.trim()) {
    return { results: [], embedMs: 0, vectorMs: 0 };
  }

  const embedStart = Date.now();
  const queryEmbedding = await embedText(query);
  const embedMs = Date.now() - embedStart;

  const vectorStart = Date.now();
  const results = await vectorSearchFromEmbedding(db, opts, queryEmbedding);
  const vectorMs = Date.now() - vectorStart;

  return { results, embedMs, vectorMs };
}

function resolveAutoMode(opts: SearchOptions): ResolvedSearchMode {
  const { query, fromAddress, afterDate, beforeDate } = opts;
  if (!query?.trim()) return "filter";

  if (fromAddress || afterDate || beforeDate) return "fts";

  const q = query.trim();
  const tokenCount = q.split(/\s+/).filter(Boolean).length;
  const looksLikeEmail = /@/.test(q);
  const looksLikeDate = /^\d{4}-\d{2}-\d{2}$/.test(q);
  const looksLikeId = /(^<[^>]+>$)|([A-Za-z0-9._%+-]+\/[A-Za-z0-9._%+-]+)/.test(q);

  if (looksLikeEmail || looksLikeDate || looksLikeId || tokenCount <= 4) {
    return "fts";
  }

  return "hybrid";
}

function resolveMode(opts: SearchOptions): ResolvedSearchMode {
  if (!opts.query?.trim()) return "filter";
  if (!opts.mode) return resolveAutoMode(opts);
  if (opts.mode === "auto") return resolveAutoMode(opts);
  return opts.mode;
}

/**
 * Generate a simple text snippet for semantic search results.
 * Finds the first occurrence of query terms (case-insensitive) and extracts surrounding context.
 */
function generateSnippet(text: string, query: string, contextLength: number = 100): string {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (words.length === 0) {
    return text.slice(0, contextLength) + (text.length > contextLength ? "…" : "");
  }

  const lowerText = text.toLowerCase();
  let bestPos = -1;
  let bestWord = "";

  // Find the first occurrence of any query word
  for (const word of words) {
    const pos = lowerText.indexOf(word);
    if (pos >= 0 && (bestPos < 0 || pos < bestPos)) {
      bestPos = pos;
      bestWord = word;
    }
  }

  if (bestPos < 0) {
    return text.slice(0, contextLength) + (text.length > contextLength ? "…" : "");
  }

  // Extract context around the match
  const start = Math.max(0, bestPos - contextLength / 2);
  const end = Math.min(text.length, bestPos + bestWord.length + contextLength / 2);
  let snippet = text.slice(start, end);

  // Highlight the matched word (simple approach)
  const matchStart = bestPos - start;
  const matchEnd = matchStart + bestWord.length;
  snippet =
    snippet.slice(0, matchStart) +
    "<b>" +
    snippet.slice(matchStart, matchEnd) +
    "</b>" +
    snippet.slice(matchEnd);

  if (start > 0) snippet = "…" + snippet;
  if (end < text.length) snippet = snippet + "…";

  return snippet;
}

/**
 * Unified search function with mode selection.
 * For filter-only queries (no query text), returns plain SQL results.
 */
export async function search(db: Database, opts: SearchOptions): Promise<SearchResult[]> {
  const result = await searchWithMeta(db, opts);
  return result.results;
}

export async function searchWithMeta(
  db: Database,
  opts: SearchOptions
): Promise<SearchResultSet> {
  const startedAt = Date.now();
  const { query, limit = 20, offset = 0 } = opts;
  const hasFilters = !!(opts.fromAddress || opts.afterDate || opts.beforeDate);
  const modeUsed = resolveMode(opts);
  const timings: SearchTimings = {
    totalMs: 0,
    modeUsed,
  };

  if (!query?.trim() && hasFilters) {
    const results = filterOnlySearch(db, opts);
    timings.totalMs = Date.now() - startedAt;
    return { results, timings };
  }

  if (!query?.trim()) {
    timings.totalMs = Date.now() - startedAt;
    return { results: [], timings };
  }

  if (modeUsed === "fts") {
    const ftsStart = Date.now();
    const results = ftsSearch(db, opts);
    timings.ftsMs = Date.now() - ftsStart;
    timings.totalMs = Date.now() - startedAt;
    return { results, timings };
  }

  if (modeUsed === "semantic") {
    const semantic = await vectorSearchWithTimings(db, opts);
    timings.embedMs = semantic.embedMs;
    timings.vectorMs = semantic.vectorMs;
    timings.totalMs = Date.now() - startedAt;
    return { results: semantic.results, timings };
  }

  const semanticPromise = vectorSearchWithTimings(db, opts);
  const ftsStart = Date.now();
  const ftsResults = ftsSearch(db, opts);
  timings.ftsMs = Date.now() - ftsStart;
  const semantic = await semanticPromise;
  timings.embedMs = semantic.embedMs;
  timings.vectorMs = semantic.vectorMs;
  const semanticResults = semantic.results;

  // Create maps for RRF scoring
  const ftsRankMap = new Map(ftsResults.map((r, idx) => [r.messageId, idx + 1]));
  const semanticRankMap = new Map(semanticResults.map((r, idx) => [r.messageId, idx + 1]));

  const mergeStart = Date.now();
  // Combine and deduplicate by messageId
  const combined = new Map<string, SearchResult & { rrfScore: number }>();

  // Add FTS results
  for (const result of ftsResults) {
    const rrfScore = 1 / (60 + (ftsRankMap.get(result.messageId) ?? 1000));
    combined.set(result.messageId, { ...result, rrfScore });
  }

  // Add semantic results, merging with existing
  for (const result of semanticResults) {
    const existing = combined.get(result.messageId);
    if (existing) {
      // Merge: keep FTS snippet (better for keyword matches), combine RRF scores
      const semanticRrf = 1 / (60 + (semanticRankMap.get(result.messageId) ?? 1000));
      existing.rrfScore += semanticRrf;
    } else {
      const semanticRrf = 1 / (60 + (semanticRankMap.get(result.messageId) ?? 1000));
      combined.set(result.messageId, { ...result, rrfScore: semanticRrf });
    }
  }

  // Sort by RRF score and apply limit/offset
  const sorted = Array.from(combined.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(offset, offset + limit);

  timings.mergeMs = Date.now() - mergeStart;
  timings.totalMs = Date.now() - startedAt;

  // Remove rrfScore from final results
  return { results: sorted.map(({ rrfScore, ...rest }) => rest), timings };
}

// Legacy exports for backwards compatibility (deprecated, will be removed)
export async function semanticSearch(db: Database, opts: SearchOptions): Promise<SearchResult[]> {
  return vectorSearch(db, opts);
}

export async function hybridSearch(db: Database, opts: SearchOptions): Promise<SearchResult[]> {
  const result = await searchWithMeta(db, { ...opts, mode: "hybrid" });
  return result.results;
}
