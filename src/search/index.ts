import type { SqliteDatabase } from "~/db";
import type { SearchResult } from "~/lib/types";
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
  /** When true, use OR logic between filters instead of AND. */
  filterOr?: boolean;
}

export interface SearchTimings {
  ftsMs?: number;
  totalMs: number;
}

export interface SearchResultSet {
  results: SearchResult[];
  timings: SearchTimings;
  totalMatched?: number; // Total number of matches before limit/offset
  _meta?: {
    hasFtsMatches: boolean;
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
 * We quote queries containing dots or other problematic characters to treat them as phrase searches.
 * 
 * Special FTS5 characters: . - @ ( ) [ ] { } + * ? | \
 * The dot (.) is the most problematic as it's common in domain names.
 * Brackets [ ] cause syntax errors and should be quoted.
 */
function escapeFts5Query(query: string): string {
  // Check for OR/AND operators (must be uppercase for FTS5)
  const hasOperators = /\b(OR|AND)\b/i.test(query);
  
  // Characters that cause FTS5 syntax errors and should trigger quoting
  const problematicChars = /[\[\]{}()]/;
  const hasProblematicChars = problematicChars.test(query);
  
  // If query contains dots or problematic characters
  // and no operators, quote the entire query as a phrase
  if (!hasOperators && (query.includes('.') || hasProblematicChars)) {
    // Escape any existing quotes and wrap in quotes
    const escaped = query.replace(/"/g, '""');
    return `"${escaped}"`;
  }
  
  // For queries with operators and dots/problematic chars, quote each part separately
  if (hasOperators && (query.includes('.') || hasProblematicChars)) {
    const parts = query.split(/\s+(OR|AND)\s+/i);
    const escapedParts: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (/^(OR|AND)$/i.test(part)) {
        escapedParts.push(part.toUpperCase());
      } else if (part.includes('.') || problematicChars.test(part)) {
        // Quote parts with dots or problematic chars
        const escaped = part.replace(/"/g, '""');
        escapedParts.push(`"${escaped}"`);
      } else {
        escapedParts.push(part);
      }
    }
    return escapedParts.join(' ');
  }
  
  // No problematic chars, return as-is
  return query;
}

/**
 * FTS5 search (keyword matching via BM25).
 * Returns results and total count.
 * Throws a user-friendly error if FTS5 syntax error occurs.
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

  try {
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
  } catch (err: any) {
    // Catch FTS5 syntax errors and provide user-friendly message
    if (err?.message?.includes('fts5') || err?.message?.includes('syntax error')) {
      const problematicChars = query.match(/[\[\]{}()]/g);
      if (problematicChars) {
        const uniqueChars = [...new Set(problematicChars)].join(' ');
        throw new Error(
          `Query contains special characters that aren't supported: ${uniqueChars}. ` +
          `Try quoting the query or removing these characters.`
        );
      }
      throw new Error(
        `Invalid search query syntax. Try simplifying your query or quoting phrases.`
      );
    }
    throw err;
  }
}

/**
 * Unified search function.
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
        hasAnyMatches: false,
      },
    };
  }

  // FTS search only
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
      hasAnyMatches: results.length > 0,
    },
  };
}

