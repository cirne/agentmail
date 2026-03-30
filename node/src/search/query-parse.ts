/**
 * Parse inline search operators from a raw query string (Gmail/notmuch style).
 * Used by CLI, MCP, and web so all interfaces behave the same.
 * Uses search-query-parser for robust parsing of keywords and quoted values.
 */

import searchQueryParser from "search-query-parser";
import { parseSinceToDate } from "~/sync/parse-since";

export interface ParsedSearchQuery {
  /** Remaining free-text query after stripping operators (for FTS/semantic). */
  query: string;
  fromAddress?: string;
  toAddress?: string;
  subject?: string;
  afterDate?: string;
  beforeDate?: string;
  /** True if the original query had OR/AND between filters (filter-only with OR/AND logic). */
  filterOr?: boolean;
}

function tryParseDate(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  try {
    return parseSinceToDate(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Parse a raw query string into structured filters and remainder query.
 * Supports: from:value, to:value, subject:value, after:value, before:value.
 * Values can be quoted to include spaces (e.g. subject:"meeting notes").
 * Comma-separated values are supported (e.g. from:alice,bob).
 * Normalizes " or " / " and " to " OR " / " AND " for FTS5.
 */
export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const result: ParsedSearchQuery = { query: "" };
  if (!raw || typeof raw !== "string" || !raw.trim()) return result;

  // Parse with search-query-parser
  const parsed = searchQueryParser.parse(raw, {
    keywords: ["from", "to", "subject", "after", "before"],
    tokenize: true,
    offsets: false,
  });

  // Extract structured filters
  if (parsed.from) {
    // search-query-parser returns arrays for comma-separated values, or strings for single values
    const fromValue = Array.isArray(parsed.from) ? parsed.from[0] : parsed.from;
    if (fromValue) result.fromAddress = String(fromValue).trim();
  }
  if (parsed.to) {
    const toValue = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
    if (toValue) result.toAddress = String(toValue).trim();
  }
  if (parsed.subject) {
    const subjectValue = Array.isArray(parsed.subject) ? parsed.subject[0] : parsed.subject;
    if (subjectValue) result.subject = String(subjectValue).trim();
  }
  if (parsed.after) {
    const afterValue = Array.isArray(parsed.after) ? parsed.after[0] : parsed.after;
    if (afterValue) {
      const d = tryParseDate(String(afterValue));
      if (d) result.afterDate = d;
    }
  }
  if (parsed.before) {
    const beforeValue = Array.isArray(parsed.before) ? parsed.before[0] : parsed.before;
    if (beforeValue) {
      const d = tryParseDate(String(beforeValue));
      if (d) result.beforeDate = d;
    }
  }

  // Extract remainder text (tokenized array from search-query-parser)
  const textParts: string[] = [];
  if (parsed.text) {
    if (Array.isArray(parsed.text)) {
      textParts.push(...parsed.text.map((t) => String(t)));
    } else {
      textParts.push(String(parsed.text));
    }
  }

  let query = textParts.join(" ").trim();
  // Normalize OR/AND for FTS5 (requires uppercase)
  query = query.replace(/\s+or\s+/gi, " OR ").replace(/\s+and\s+/gi, " AND ");
  
  // If query is just "OR" or "AND" and we have multiple filters, this is a filter-only query
  // with OR/AND logic. Clear the query so it's handled as filter-only.
  const hasMultipleFilters = 
    [result.fromAddress, result.toAddress, result.subject, result.afterDate, result.beforeDate]
      .filter(Boolean).length > 1;
  
  // Check if query is just OR/AND operators (possibly repeated, e.g. "OR OR" for three filters)
  // This indicates filter-only with OR/AND logic. Use case-insensitive check.
  const trimmedQuery = query.trim();
  const isOnlyOrAnd = /^(OR|AND)(\s+(OR|AND))*$/i.test(trimmedQuery);
  
  // Remove leading/trailing OR/AND that would cause FTS5 syntax errors (but preserve the flag)
  if (isOnlyOrAnd && hasMultipleFilters) {
    query = "";
    // Determine if it's OR or AND logic (check first operator in original text, case-insensitive)
    const originalText = textParts.join(" ").trim();
    result.filterOr = /^OR/i.test(originalText);
  } else if (isOnlyOrAnd) {
    query = "";
  } else {
    // Remove stray OR/AND at start/end that would cause syntax errors
    query = query.replace(/^\s*(OR|AND)\s+/i, "").replace(/\s+(OR|AND)\s*$/i, "");
  }
  
  result.query = query;
  return result;
}
