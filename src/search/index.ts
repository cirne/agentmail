import type { SqliteDatabase } from "~/db";
import type { SearchResult } from "~/lib/types";
import {
  SEARCH_CONTACT_RANK_BOOST_ALPHA,
  filterOnlyCombinedRankFromMessageDate,
} from "~/lib/contact-rank";
import { indexAttachmentsByMessageId } from "~/attachments/list-for-message";
import { normalizeAddress } from "./normalize";
import { computeContactRankMapForAddresses, parseJsonAddresses } from "./owner-contact-stats";
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
  /** Mailbox owner (IMAP user). When set, search ranking applies a small participant contact-rank boost (OPP-027). */
  ownerAddress?: string;
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

type FtsRow = SearchResult & { combinedRank: number };

/** After FTS+date ordering, optionally rerank by max participant contact rank (OPP-027). */
async function applyContactRankRerank(
  db: SqliteDatabase,
  ownerAddress: string | undefined,
  rows: FtsRow[]
): Promise<SearchResult[]> {
  if (!ownerAddress?.trim() || rows.length === 0) {
    return rows.map(({ combinedRank: _c, ...r }) => r);
  }

  const ownerNorm = normalizeAddress(ownerAddress);
  const ids = [...new Set(rows.map((r) => r.messageId))];
  const placeholders = ids.map(() => "?").join(",");
  const metaRows = (await (
    await db.prepare(
      /* sql */ `
      SELECT message_id AS messageId, from_address AS fromAddress,
             to_addresses AS toAddresses, cc_addresses AS ccAddresses
      FROM messages
      WHERE message_id IN (${placeholders})
    `
    )
  ).all(...ids)) as Array<{
    messageId: string;
    fromAddress: string;
    toAddresses: string;
    ccAddresses: string;
  }>;

  const byId = new Map(metaRows.map((m) => [m.messageId, m]));
  const allAddresses = new Set<string>();
  for (const m of metaRows) {
    allAddresses.add(normalizeAddress(m.fromAddress));
    for (const a of parseJsonAddresses(m.toAddresses)) allAddresses.add(normalizeAddress(a));
    for (const a of parseJsonAddresses(m.ccAddresses)) allAddresses.add(normalizeAddress(a));
  }
  allAddresses.delete(ownerNorm);

  const rankMap = await computeContactRankMapForAddresses(db, ownerAddress, allAddresses);
  const alpha = SEARCH_CONTACT_RANK_BOOST_ALPHA;
  const debug = Boolean(process.env.DEBUG_SEARCH);

  const scored = rows.map((r) => {
    const m = byId.get(r.messageId);
    let maxRank = 0;
    if (m) {
      const parts = new Set<string>();
      parts.add(normalizeAddress(m.fromAddress));
      for (const a of parseJsonAddresses(m.toAddresses)) parts.add(normalizeAddress(a));
      for (const a of parseJsonAddresses(m.ccAddresses)) parts.add(normalizeAddress(a));
      parts.delete(ownerNorm);
      for (const p of parts) {
        maxRank = Math.max(maxRank, rankMap.get(p) ?? 0);
      }
    }
    const finalRank = r.combinedRank - alpha * maxRank;
    const contactRankBoost = debug ? alpha * maxRank : undefined;
    return { row: r, finalRank, contactRankBoost };
  });

  scored.sort((a, b) => {
    if (a.finalRank !== b.finalRank) return a.finalRank - b.finalRank;
    return b.row.date.localeCompare(a.row.date);
  });

  return scored.map(({ row, contactRankBoost }) => {
    const { combinedRank: _cr, ...rest } = row;
    const out: SearchResult = { ...rest };
    if (contactRankBoost !== undefined) out.contactRankBoost = contactRankBoost;
    return out;
  });
}

/** Batch-load attachment metadata (filename order + 1-based index, same as `zmail attachment list`). */
async function mergeAttachmentMetadata(
  db: SqliteDatabase,
  results: SearchResult[]
): Promise<SearchResult[]> {
  if (results.length === 0) return results;
  const byMessage = await indexAttachmentsByMessageId(
    db,
    results.map((r) => r.messageId)
  );
  return results.map((r) => {
    const list = byMessage.get(r.messageId) ?? [];
    return {
      ...r,
      attachments: list.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        extracted: a.extracted,
        index: a.index,
      })),
    };
  });
}

/** Load full thread messages (for includeThreads). */
async function loadThreads(
  db: SqliteDatabase,
  threadIds: string[]
): Promise<ThreadSearchResult[]> {
  if (threadIds.length === 0) return [];
  const bodyPreviewSql = `COALESCE(TRIM(SUBSTR(body_text, 1, ${BODY_PREVIEW_LEN})), '') || (CASE WHEN LENGTH(TRIM(body_text)) > ${BODY_PREVIEW_LEN} THEN '…' ELSE '' END)`;
  const placeholders = threadIds.map(() => "?").join(",");
  const rows = (await (
    await db.prepare(
      /* sql */ `
    SELECT thread_id AS threadId, message_id AS messageId, from_address AS fromAddress, from_name AS fromName,
           subject, date, ${bodyPreviewSql} AS bodyPreview
    FROM messages
    WHERE thread_id IN (${placeholders})
    ORDER BY thread_id, date ASC
    `
    )
  ).all(...threadIds)) as Array<{
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
async function filterOnlySearch(
  db: SqliteDatabase,
  opts: SearchOptions
): Promise<{ results: SearchResult[]; totalCount: number }> {
  const { limit, offset = 0 } = opts;
  const filterClause = buildFilterClause(opts);
  const where = filterClause.conditions.length > 0 ? `WHERE ${buildWhereClause(filterClause)}` : "";

  const countResult = (await (
    await db.prepare(
      /* sql */ `
      SELECT COUNT(*) as count
      FROM messages m
      ${where}
    `
    )
  ).get(...filterClause.params)) as { count: number };

  const sqlLimit = limit != null ? limit + offset + 50 : -1;
  const params = [...filterClause.params, sqlLimit];
  const bodyPreviewSql = `COALESCE(TRIM(SUBSTR(m.body_text, 1, 300)), '') || (CASE WHEN LENGTH(TRIM(m.body_text)) > 300 THEN '…' ELSE '' END)`;
  const rows = (await (
    await db.prepare(
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
      LIMIT ?
    `
    )
  ).all(...params)) as unknown as SearchResult[];

  const withCombined: FtsRow[] = rows.map((r) => ({
    ...r,
    combinedRank: filterOnlyCombinedRankFromMessageDate(r.date),
  }));
  const reranked = await applyContactRankRerank(db, opts.ownerAddress, withCombined);
  const results =
    limit != null ? reranked.slice(offset, offset + limit) : reranked.slice(offset);
  return { results, totalCount: countResult.count };
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
async function ftsSearch(
  db: SqliteDatabase,
  opts: SearchOptions
): Promise<{ results: SearchResult[]; totalCount: number }> {
  const { query, limit, offset = 0 } = opts;
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
    const totalCount = (await (
      await db.prepare(
        /* sql */ `
        SELECT COUNT(*) as count
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.rowid
        ${where}
      `
      )
    ).get(...countParams)) as { count: number };

    const sqlLimit = limit != null ? limit + offset + 50 : -1;
    const params = [escapedQuery, ...filterClause.params, sqlLimit];

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
    
    const rawRows = (await (
      await db.prepare(
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
    ).all(...params)) as unknown as Array<
      SearchResult & { combined_rank: number }
    >;

    const withCombined: FtsRow[] = rawRows.map((r) => {
      const { combined_rank, ...rest } = r;
      return { ...rest, combinedRank: combined_rank };
    });

    const reranked = await applyContactRankRerank(db, opts.ownerAddress, withCombined);
    const results = limit != null ? reranked.slice(offset, offset + limit) : reranked.slice(offset);
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
 * Filter-only queries (no query text) use date-based combined rank plus optional contact-rank rerank like FTS.
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
    const { results, totalCount } = await filterOnlySearch(db, effectiveOpts);
    timings.totalMs = Date.now() - startedAt;
    const resultsWithAttachments = await mergeAttachmentMetadata(db, results);
    const threads = effectiveOpts.includeThreads
      ? await loadThreads(db, [...new Set(resultsWithAttachments.map((r) => r.threadId))])
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
  const { results, totalCount } = await ftsSearch(db, effectiveOpts);
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
  const resultsWithAttachments = await mergeAttachmentMetadata(db, results);
  const threads = effectiveOpts.includeThreads
    ? await loadThreads(db, [...new Set(resultsWithAttachments.map((r) => r.threadId))])
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

