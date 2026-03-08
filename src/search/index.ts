import type { SqliteDatabase } from "~/db";
import type { SearchResult } from "~/lib/types";
import { embedText } from "./embeddings";
import { searchVectors } from "./vectors";
import { parseSearchQuery } from "./query-parse";
import { buildFilterClause, buildWhereClause } from "./filter-compiler";

// ResolvedSearchMode type removed - no longer needed

export interface SearchOptions {
  query?: string;
  limit?: number;
  offset?: number;
  fromAddress?: string;
  toAddress?: string;
  subject?: string;
  afterDate?: string;
  beforeDate?: string;
  /** When true, use FTS-only search (exact keyword matching). Default is hybrid (semantic + FTS). */
  fts?: boolean;
  /** When true, use OR logic between filters instead of AND. */
  filterOr?: boolean;
}

export interface SearchTimings {
  ftsMs?: number;
  embedMs?: number;
  vectorMs?: number;
  mergeMs?: number;
  totalMs: number;
}

export interface SearchResultSet {
  results: SearchResult[];
  timings: SearchTimings;
  totalMatched?: number; // Total number of matches before limit/offset
  _meta?: {
    hasFtsMatches: boolean;
    hasSemanticOnlyMatches: boolean;
    hasAnyMatches: boolean;
  };
}

// fromFilterPattern is now in filter-compiler.ts

/**
 * Filter-only search (no query text, just WHERE clauses).
 * Returns results and total count.
 */
function filterOnlySearch(db: SqliteDatabase, opts: SearchOptions): { results: SearchResult[]; totalCount: number } {
  const { limit = 50, offset = 0 } = opts; // Increased default from 20 to 50
  const filterClause = buildFilterClause(opts);
  const where = filterClause.conditions.length > 0 ? `WHERE ${buildWhereClause(filterClause)}` : "";

  // Get total count first
  const countResult = db
    .prepare(
      /* sql */ `
      SELECT COUNT(*) as count
      FROM messages m
      ${where}
    `
    )
    .get(...filterClause.params) as { count: number };

  // Then get results
  const params = [...filterClause.params, limit, offset];
  const rows = db
    .prepare(
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
  return { results: rows, totalCount: countResult.count };
}

/**
 * Escape FTS5 special characters in query string.
 * FTS5 treats dots (.) as token separators, which causes syntax errors.
 * We quote queries containing dots to treat them as phrase searches.
 * 
 * Special FTS5 characters: . - @ ( ) [ ] { } + * ? | \
 * The dot (.) is the most problematic as it's common in domain names.
 */
function escapeFts5Query(query: string): string {
  // Check for OR/AND operators (must be uppercase for FTS5)
  const hasOperators = /\b(OR|AND)\b/i.test(query);
  
  // If query contains dots (common in domain names like "apple.com")
  // and no operators, quote the entire query as a phrase
  if (!hasOperators && query.includes('.')) {
    // Escape any existing quotes and wrap in quotes
    const escaped = query.replace(/"/g, '""');
    return `"${escaped}"`;
  }
  
  // For queries with operators and dots, quote each part separately
  if (hasOperators && query.includes('.')) {
    const parts = query.split(/\s+(OR|AND)\s+/i);
    const escapedParts: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (/^(OR|AND)$/i.test(part)) {
        escapedParts.push(part.toUpperCase());
      } else if (part.includes('.')) {
        // Quote parts with dots
        const escaped = part.replace(/"/g, '""');
        escapedParts.push(`"${escaped}"`);
      } else {
        escapedParts.push(part);
      }
    }
    return escapedParts.join(' ');
  }
  
  // No dots, return as-is (FTS5 handles other special chars reasonably)
  return query;
}

/**
 * FTS5 search (keyword matching via BM25).
 * Returns results and total count.
 */
function ftsSearch(db: SqliteDatabase, opts: SearchOptions): { results: SearchResult[]; totalCount: number } {
  const { query, limit = 50, offset = 0 } = opts; // Increased default from 20 to 50
  if (!query?.trim()) return { results: [], totalCount: 0 };

  // Escape FTS5 special characters
  const escapedQuery = escapeFts5Query(query);

  // Build filter clause with FTS MATCH condition
  const filterClause = buildFilterClause(opts, true, "messages_fts MATCH ?");
  const whereClause = buildWhereClause(filterClause);
  const where = `WHERE ${whereClause}`;

  // First, get total count (before limit/offset)
  const countParams = [escapedQuery, ...filterClause.params];
  const totalCount = db
    .prepare(
      /* sql */ `
      SELECT COUNT(*) as count
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      ${where}
    `
    )
    .get(...countParams) as { count: number };

  // Then get results
  const params = [escapedQuery, ...filterClause.params, limit + offset + 50];

  const rows = db
    .prepare(
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
      ${where}
      ORDER BY rank
      LIMIT ?
    `
    )
    .all(...params) as SearchResult[];

  // Apply post-query filtering and limit/offset
  const results = rows.slice(offset, offset + limit);
  return { results, totalCount: totalCount.count };
}

/**
 * Semantic/vector search.
 */
async function vectorSearchFromEmbedding(
  db: SqliteDatabase,
  opts: SearchOptions,
  queryEmbedding: number[]
): Promise<{ results: SearchResult[]; rawScores: Map<string, number> }> {
  const { query, limit = 50, offset = 0 } = opts; // Increased default from 20 to 50
  if (!query?.trim()) return { results: [], rawScores: new Map() };

  // Search LanceDB for similar messages
  const vectorResults = await searchVectors(queryEmbedding, limit + offset + 50); // Get extra for filtering

  // Filter out low-confidence semantic matches
  const filteredResults = vectorResults.filter((r) => r.score >= SEMANTIC_SCORE_THRESHOLD);

  // Fetch full message details from SQLite and apply filters
  const messageIds = filteredResults.map((r) => r.messageId);
  if (messageIds.length === 0) return { results: [], rawScores: new Map() };

  const placeholders = messageIds.map(() => "?").join(",");
  
  // Build filter clause (message_id IN condition is handled separately for vector search)
  const filterClause = buildFilterClause(opts);
  const conditions: string[] = [`m.message_id IN (${placeholders})`];
  const params: (string | number)[] = [...messageIds];
  
  // Add filter conditions (always AND for vector search since we're filtering already-matched results)
  if (filterClause.conditions.length > 0) {
    conditions.push(...filterClause.conditions);
    params.push(...filterClause.params);
  }

  // Fetch messages and preserve vector search order
  const messages = db
    .prepare(
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
  const scoreMap = new Map(filteredResults.map((r) => [r.messageId, r.score]));
  const rawScores = new Map(filteredResults.map((r) => [r.messageId, r.score]));

  // Sort by vector score (highest first), then apply limit/offset
  const sorted = messages
    .map((m) => ({
      ...m,
      rank: scoreMap.get(m.messageId) ?? 0,
      snippet: generateSnippet(m.bodyText, query), // Simple snippet generation
    }))
    .sort((a, b) => b.rank - a.rank)
    .slice(offset, offset + limit);

  return { results: sorted.map(({ bodyText, ...rest }) => rest), rawScores };
}

async function vectorSearch(db: SqliteDatabase, opts: SearchOptions): Promise<SearchResult[]> {
  const { query } = opts;
  if (!query?.trim()) return [];
  const queryEmbedding = await embedText(query);
  const { results } = await vectorSearchFromEmbedding(db, opts, queryEmbedding);
  return results;
}

interface VectorSearchRun {
  results: SearchResult[];
  embedMs: number;
  vectorMs: number;
  rawScores: Map<string, number>; // messageId -> semantic score
}

// Minimum semantic similarity score threshold (0.45 = cosine distance ~1.22)
// Good semantic matches cluster around 0.46-0.50, garbage around 0.40-0.44
// This threshold filters gibberish while preserving legitimate semantic matches
const SEMANTIC_SCORE_THRESHOLD = 0.45;

async function vectorSearchWithTimings(
  db: SqliteDatabase,
  opts: SearchOptions
): Promise<VectorSearchRun> {
  const { query } = opts;
  if (!query?.trim()) {
    return { results: [], embedMs: 0, vectorMs: 0, rawScores: new Map() };
  }

  const embedStart = Date.now();
  const queryEmbedding = await embedText(query);
  const embedMs = Date.now() - embedStart;

  const vectorStart = Date.now();
  const { results, rawScores } = await vectorSearchFromEmbedding(db, opts, queryEmbedding);
  const vectorMs = Date.now() - vectorStart;

  return { results, embedMs, vectorMs, rawScores };
}

// resolveMode function removed - no longer needed since we always use hybrid unless fts flag is set

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
export async function search(db: SqliteDatabase, opts: SearchOptions): Promise<SearchResult[]> {
  const result = await searchWithMeta(db, opts);
  return result.results;
}

export async function searchWithMeta(
  db: SqliteDatabase,
  opts: SearchOptions
): Promise<SearchResultSet> {
  const startedAt = Date.now();

  // Parse inline operators from query string if present
  let parsedQuery = opts.query || "";
  let effectiveOpts = { ...opts };
  if (opts.query && opts.query.trim()) {
    const parsed = parseSearchQuery(opts.query);
    // Merge parsed filters into opts (parsed filters override explicit opts)
    if (parsed.fromAddress && !opts.fromAddress) effectiveOpts.fromAddress = parsed.fromAddress;
    if (parsed.toAddress && !opts.toAddress) effectiveOpts.toAddress = parsed.toAddress;
    if (parsed.subject && !opts.subject) effectiveOpts.subject = parsed.subject;
    if (parsed.afterDate && !opts.afterDate) effectiveOpts.afterDate = parsed.afterDate;
    if (parsed.beforeDate && !opts.beforeDate) effectiveOpts.beforeDate = parsed.beforeDate;
    // Use parsed remainder as the query
    parsedQuery = parsed.query;
    
    // If parser detected filter-only with OR/AND logic, use that flag
    if (parsed.filterOr !== undefined) {
      effectiveOpts.filterOr = parsed.filterOr;
    }
  }

  const { limit = 50, offset = 0 } = effectiveOpts; // Increased default from 20 to 50 for agent workflows
  const hasFilters = !!(effectiveOpts.fromAddress || effectiveOpts.toAddress || effectiveOpts.subject || effectiveOpts.afterDate || effectiveOpts.beforeDate);
  
  // Update query in opts for search functions
  effectiveOpts.query = parsedQuery;
  
  const timings: SearchTimings = {
    totalMs: 0,
  };

  if (!parsedQuery?.trim() && hasFilters) {
    const { results, totalCount } = filterOnlySearch(db, effectiveOpts);
    timings.totalMs = Date.now() - startedAt;
    return {
      results,
      timings,
      totalMatched: totalCount,
      _meta: {
        hasFtsMatches: results.length > 0,
        hasSemanticOnlyMatches: false,
        hasAnyMatches: results.length > 0,
      },
    };
  }

  if (!parsedQuery?.trim()) {
    timings.totalMs = Date.now() - startedAt;
    return {
      results: [],
      timings,
      _meta: {
        hasFtsMatches: false,
        hasSemanticOnlyMatches: false,
        hasAnyMatches: false,
      },
    };
  }

  // Determine search mode: FTS-only if fts flag is set, otherwise hybrid
  const useFtsOnly = effectiveOpts.fts === true;

  if (useFtsOnly) {
    const ftsStart = Date.now();
    const { results, totalCount } = ftsSearch(db, effectiveOpts);
    timings.ftsMs = Date.now() - ftsStart;
    timings.totalMs = Date.now() - startedAt;
    return {
      results,
      timings,
      totalMatched: totalCount,
      _meta: {
        hasFtsMatches: results.length > 0,
        hasSemanticOnlyMatches: false,
        hasAnyMatches: results.length > 0,
      },
    };
  }

  // Default: hybrid search (semantic + FTS)
  const semanticPromise = vectorSearchWithTimings(db, effectiveOpts);
  const ftsStart = Date.now();
  const ftsSearchResult = ftsSearch(db, effectiveOpts);
  const ftsResults = ftsSearchResult.results;
  const ftsTotalCount = ftsSearchResult.totalCount;
  timings.ftsMs = Date.now() - ftsStart;
  const semantic = await semanticPromise;
  timings.embedMs = semantic.embedMs;
  timings.vectorMs = semantic.vectorMs;
  const semanticResults = semantic.results;

  // Track which results came from FTS vs semantic-only
  const ftsMessageIds = new Set(ftsResults.map((r) => r.messageId));
  const semanticOnlyMessageIds = new Set(
    semanticResults.map((r) => r.messageId).filter((id) => !ftsMessageIds.has(id))
  );

  // Create maps for RRF scoring
  const ftsRankMap = new Map(ftsResults.map((r, idx) => [r.messageId, idx + 1]));
  const semanticRankMap = new Map(semanticResults.map((r, idx) => [r.messageId, idx + 1]));

  const mergeStart = Date.now();
  // Combine and deduplicate by messageId
  const combined = new Map<string, SearchResult & { rrfScore: number; hasFtsMatch: boolean }>();

  // Add FTS results
  for (const result of ftsResults) {
    const rrfScore = 1 / (60 + (ftsRankMap.get(result.messageId) ?? 1000));
    combined.set(result.messageId, { ...result, rrfScore, hasFtsMatch: true });
  }

  // Add semantic results, merging with existing
  for (const result of semanticResults) {
    const existing = combined.get(result.messageId);
    if (existing) {
      // Merge: keep FTS snippet (better for keyword matches), combine RRF scores
      const semanticRrf = 1 / (60 + (semanticRankMap.get(result.messageId) ?? 1000));
      existing.rrfScore += semanticRrf;
      // Already has FTS match, keep hasFtsMatch: true
    } else {
      const semanticRrf = 1 / (60 + (semanticRankMap.get(result.messageId) ?? 1000));
      combined.set(result.messageId, { ...result, rrfScore: semanticRrf, hasFtsMatch: false });
    }
  }

  // Sort by RRF score and apply limit/offset
  const sorted = Array.from(combined.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(offset, offset + limit);

  timings.mergeMs = Date.now() - mergeStart;
  timings.totalMs = Date.now() - startedAt;

  // Track metadata for hint generation: do we have FTS matches, semantic-only matches, or neither?
  const hasFtsMatches = ftsResults.length > 0;
  const hasSemanticOnlyMatches = semanticOnlyMessageIds.size > 0;
  const hasAnyMatches = sorted.length > 0;

  // Remove rrfScore and hasFtsMatch from final results
  // For hybrid search, use FTS total count as the primary count (semantic is supplementary)
  // The combined set may be larger than FTS alone, but FTS count is more reliable for pagination
  return {
    results: sorted.map(({ rrfScore, hasFtsMatch, ...rest }) => rest),
    timings,
    totalMatched: ftsTotalCount, // Use FTS count as primary; combined results may exceed this
    _meta: {
      hasFtsMatches,
      hasSemanticOnlyMatches,
      hasAnyMatches,
    },
  };
}

// Legacy exports for backwards compatibility (deprecated, will be removed)
export async function semanticSearch(db: SqliteDatabase, opts: SearchOptions): Promise<SearchResult[]> {
  return vectorSearch(db, opts);
}

export async function hybridSearch(db: SqliteDatabase, opts: SearchOptions): Promise<SearchResult[]> {
  // Hybrid is now the default, so just call searchWithMeta without fts flag
  const result = await searchWithMeta(db, { ...opts, fts: false });
  return result.results;
}
