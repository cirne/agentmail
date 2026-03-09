import type { SqliteDatabase } from "~/db";
import type { SearchResult, SearchResultAttachment } from "~/lib/types";
import { parseSearchQuery } from "./query-parse";
import { buildFilterClause, buildWhereClause } from "./filter-compiler";

/** One message in a thread when includeThreads is true (avoids get_thread round-trip). */
export interface ThreadMessageInSearch {
  messageId: string;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  date: string;
  bodyPreview: string;
}

export interface ThreadSearchResult {
  threadId: string;
  subject: string;
  messages: ThreadMessageInSearch[];
}

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
  /** When true, also return full threads (all messages per matching thread_id). Default false. */
  includeThreads?: boolean;
  /** When true, includes noise messages (promotional, social, forums, bulk, spam). Defaults to false (noise excluded). */
  includeNoise?: boolean;
}

export interface SearchTimings {
  ftsMs?: number;
  totalMs: number;
}

export interface SearchResultSet {
  results: SearchResult[];
  timings: SearchTimings;
  totalMatched?: number; // Total number of matches before limit/offset
  /** When includeThreads is true, full conversation per matching thread. */
  threads?: ThreadSearchResult[];
  _meta?: {
    hasFtsMatches: boolean;
    hasAnyMatches: boolean;
  };
}

// fromFilterPattern is now in filter-compiler.ts

const BODY_PREVIEW_LEN = 300;

/** Batch-load attachment metadata for result message_ids and merge onto each result (1-based index). */
function mergeAttachmentMetadata(
  db: SqliteDatabase,
  results: SearchResult[]
): SearchResult[] {
  if (results.length === 0) return results;
  const ids = results.map((r) => r.messageId);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      /* sql */ `
    SELECT message_id AS messageId, id, filename, mime_type AS mimeType
    FROM attachments
    WHERE message_id IN (${placeholders})
    ORDER BY message_id, id
    `
    )
    .all(...ids) as Array<{ messageId: string; id: number; filename: string; mimeType: string }>;
  const byMessage = new Map<string, SearchResultAttachment[]>();
  for (const row of rows) {
    const list = byMessage.get(row.messageId) ?? [];
    list.push({ id: row.id, filename: row.filename, mimeType: row.mimeType, index: list.length + 1 });
    byMessage.set(row.messageId, list);
  }
  return results.map((r) => ({
    ...r,
    attachments: byMessage.get(r.messageId) ?? [],
  }));
}

/** Load full thread messages (for includeThreads). */
function loadThreads(
  db: SqliteDatabase,
  threadIds: string[]
): ThreadSearchResult[] {
  if (threadIds.length === 0) return [];
  const bodyPreviewSql = `COALESCE(TRIM(SUBSTR(body_text, 1, ${BODY_PREVIEW_LEN})), '') || (CASE WHEN LENGTH(TRIM(body_text)) > ${BODY_PREVIEW_LEN} THEN '…' ELSE '' END)`;
  const placeholders = threadIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      /* sql */ `
    SELECT thread_id AS threadId, message_id AS messageId, from_address AS fromAddress, from_name AS fromName,
           subject, date, ${bodyPreviewSql} AS bodyPreview
    FROM messages
    WHERE thread_id IN (${placeholders})
    ORDER BY thread_id, date ASC
    `
    )
    .all(...threadIds) as Array<{
      threadId: string;
      messageId: string;
      fromAddress: string;
      fromName: string | null;
      subject: string;
      date: string;
      bodyPreview: string;
    }>;
  const byThread = new Map<string, ThreadMessageInSearch[]>();
  for (const row of rows) {
    const list = byThread.get(row.threadId) ?? [];
    list.push({
      messageId: row.messageId,
      fromAddress: row.fromAddress,
      fromName: row.fromName,
      subject: row.subject,
      date: row.date,
      bodyPreview: row.bodyPreview,
    });
    byThread.set(row.threadId, list);
  }
  const threads: ThreadSearchResult[] = [];
  for (const tid of threadIds) {
    const messages = byThread.get(tid);
    if (messages?.length) threads.push({ threadId: tid, subject: messages[0].subject, messages });
  }
  return threads;
}

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

  // Then get results (bodyPreview = first 300 chars to reduce follow-up reads)
  const params = [...filterClause.params, limit, offset];
  const bodyPreviewSql = `COALESCE(TRIM(SUBSTR(m.body_text, 1, 300)), '') || (CASE WHEN LENGTH(TRIM(m.body_text)) > 300 THEN '…' ELSE '' END)`;
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
        ${bodyPreviewSql} AS bodyPreview,
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
 * Convert space-separated words to OR-based query (Google-style search).
 * FTS5 treats space-separated words as AND by default, but we want OR behavior
 * where results matching more terms rank higher (via BM25).
 * 
 * Preserves:
 * - Quoted phrases (kept as-is)
 * - Explicit OR/AND operators
 * - Special characters (quoted if needed)
 */
function convertToOrQuery(query: string): string {
  // Check if query already has explicit OR/AND operators
  const hasExplicitOperators = /\b(OR|AND)\b/i.test(query);
  
  // If explicit operators exist, preserve them (user intent)
  if (hasExplicitOperators) {
    return escapeFts5Query(query);
  }
  
  // Check for quoted phrases - preserve them
  const quotedPhrases: string[] = [];
  const placeholder = '___QUOTED_PHRASE___';
  let queryWithPlaceholders = query;
  let placeholderIndex = 0;
  
  // Extract quoted phrases
  queryWithPlaceholders = queryWithPlaceholders.replace(/"([^"]+)"/g, (_match, phrase) => {
    const ph = `${placeholder}${placeholderIndex}`;
    quotedPhrases.push(phrase);
    placeholderIndex++;
    return ph;
  });
  
  // Split by spaces and convert to OR
  const parts = queryWithPlaceholders.split(/\s+/).filter(p => p.trim());
  
  if (parts.length <= 1) {
    // Single term or empty - return as-is (after restoring quotes)
    let result = query;
    quotedPhrases.forEach((phrase, idx) => {
      result = result.replace(`${placeholder}${idx}`, `"${phrase.replace(/"/g, '""')}"`);
    });
    return escapeFts5Query(result);
  }
  
  // Convert space-separated words to OR
  const orParts: string[] = [];
  for (const part of parts) {
    if (part.startsWith(placeholder)) {
      // Restore quoted phrase
      const idx = parseInt(part.replace(placeholder, ''), 10);
      const phrase = quotedPhrases[idx];
      orParts.push(`"${phrase.replace(/"/g, '""')}"`);
    } else {
      // Regular word - add as-is (will be OR'd)
      orParts.push(part);
    }
  }
  
  // Join with OR
  const orQuery = orParts.join(' OR ');
  
  // Apply final escaping for special characters
  return escapeFts5Query(orQuery);
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
    // But if it's already an OR query, handle each part separately
    if (query.includes(' OR ')) {
      const parts = query.split(/\s+OR\s+/i);
      const escapedParts: string[] = [];
      for (const part of parts) {
        if (part.includes('.') || problematicChars.test(part)) {
          const escaped = part.replace(/"/g, '""');
          escapedParts.push(`"${escaped}"`);
        } else {
          escapedParts.push(part);
        }
      }
      return escapedParts.join(' OR ');
    }
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

  // Convert space-separated words to OR query (Google-style search)
  // This makes queries like "advisory meeting tomorrow" match emails with any of those terms,
  // with BM25 ranking naturally putting results matching more terms higher
  const escapedQuery = convertToOrQuery(query);
  if (process.env.DEBUG_SEARCH) {
    process.stderr.write(`[search] original query: "${query}" → converted: "${escapedQuery}"\n`);
  }
  // #region agent log
  if (/apple/i.test(query)) {
    fetch("http://127.0.0.1:7346/ingest/335842d0-019d-4436-8e39-976da7aa5bff", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "7c1ba9" },
      body: JSON.stringify({
        sessionId: "7c1ba9",
        location: "search/index.ts:ftsSearch",
        message: "FTS escaped query (apple-related)",
        data: { originalQuery: query, escapedQuery },
        timestamp: Date.now(),
        hypothesisId: "H1",
      }),
    }).catch(() => {});
  }
  // #endregion

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

    const bodyPreviewSql = `COALESCE(TRIM(SUBSTR(m.body_text, 1, 300)), '') || (CASE WHEN LENGTH(TRIM(m.body_text)) > 300 THEN '…' ELSE '' END)`;
    
    // Combine BM25 rank with date recency boost
    // FTS5 rank: lower (more negative) values = better matches
    // Date boost: subtract larger values for recent emails to improve their rank
    // Formula: combined_rank = rank - dateBoost (recent emails get larger dateBoost)
    // This makes recent emails have lower (better) combined_rank values
    const daysAgo = `julianday('now') - julianday(m.date)`;
    const dateBoostSql = `
      CASE 
        WHEN ${daysAgo} <= 1 THEN 10.0
        WHEN ${daysAgo} <= 7 THEN 8.0 - (${daysAgo} * 0.5)
        WHEN ${daysAgo} <= 30 THEN 4.5 - ((${daysAgo} - 7) * 0.1)
        WHEN ${daysAgo} <= 90 THEN 1.2 - ((${daysAgo} - 30) * 0.01)
        ELSE 0.6 - ((${daysAgo} - 90) * 0.001)
      END
    `;
    
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
          ${bodyPreviewSql} AS bodyPreview,
          rank,
          (rank - ${dateBoostSql}) AS combined_rank
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        ${where}
        ORDER BY combined_rank ASC, m.date DESC
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
  
  // Update query in opts for search functions
  effectiveOpts.query = parsedQuery;

  // #region agent log
  const path = !parsedQuery?.trim() ? "filterOnly" : "fts";
  fetch("http://127.0.0.1:7346/ingest/335842d0-019d-4436-8e39-976da7aa5bff", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "7c1ba9" },
    body: JSON.stringify({
      sessionId: "7c1ba9",
      location: "search/index.ts:searchWithMeta",
      message: "effective opts and path",
      data: { effectiveQuery: effectiveOpts.query, fromAddress: effectiveOpts.fromAddress, afterDate: effectiveOpts.afterDate, path },
      timestamp: Date.now(),
      hypothesisId: "H1_H2",
    }),
  }).catch(() => {});
  // #endregion
  
  const timings: SearchTimings = {
    totalMs: 0,
  };

  if (!parsedQuery?.trim()) {
    const { results, totalCount } = filterOnlySearch(db, effectiveOpts);
    timings.totalMs = Date.now() - startedAt;
    const resultsWithAttachments = mergeAttachmentMetadata(db, results);
    const threads = effectiveOpts.includeThreads
      ? loadThreads(db, [...new Set(resultsWithAttachments.map((r) => r.threadId))])
      : undefined;
    return {
      results: resultsWithAttachments,
      timings,
      totalMatched: totalCount,
      ...(threads?.length ? { threads } : {}),
      _meta: {
        hasFtsMatches: results.length > 0,
        hasAnyMatches: results.length > 0,
      },
    };
  }

  // FTS search only
  const ftsStart = Date.now();
  const { results, totalCount } = ftsSearch(db, effectiveOpts);
  // #region agent log
  if (/apple/i.test(effectiveOpts.query ?? "")) {
    fetch("http://127.0.0.1:7346/ingest/335842d0-019d-4436-8e39-976da7aa5bff", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "7c1ba9" },
      body: JSON.stringify({
        sessionId: "7c1ba9",
        location: "search/index.ts:searchWithMeta after ftsSearch",
        message: "FTS result count (apple-related query)",
        data: { ftsTotalCount: totalCount, ftsResultsLength: results.length },
        timestamp: Date.now(),
        hypothesisId: "H1",
      }),
    }).catch(() => {});
  }
  // #endregion
  timings.ftsMs = Date.now() - ftsStart;
  timings.totalMs = Date.now() - startedAt;
  const resultsWithAttachments = mergeAttachmentMetadata(db, results);
  const threads = effectiveOpts.includeThreads
    ? loadThreads(db, [...new Set(resultsWithAttachments.map((r) => r.threadId))])
    : undefined;
  return {
    results: resultsWithAttachments,
    timings,
    totalMatched: totalCount,
    ...(threads?.length ? { threads } : {}),
    _meta: {
      hasFtsMatches: results.length > 0,
      hasAnyMatches: results.length > 0,
    },
  };
}

