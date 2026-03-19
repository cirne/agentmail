import type { SqliteDatabase } from "~/db";
import { searchWithMeta } from "~/search";
import type { SearchResult } from "~/lib/types";
import { parseSinceToDate } from "~/sync/parse-since";
import { verboseLog } from "./verbose";
import type { SearchPlan } from "./planner";

/**
 * Resolve a date string to an ISO date string (YYYY-MM-DD).
 * Handles:
 *   - Relative strings:  "30d", "7d", "1w", "3m", "0d" (0d = start of today)
 *   - ISO dates:         "2026-01-01" (passed through)
 *   - US short dates:    "1/1/26", "01/01/2026", "1/1/2026"
 */
function resolveDate(dateStr: string | undefined): string | undefined {
  if (!dateStr) return undefined;

  // Already an ISO date (YYYY-MM-DD or full ISO)
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return dateStr;

  // "0d" = today (start of day). parseSinceToDate rejects num <= 0, so handle here.
  const trimmed = dateStr.trim().toLowerCase();
  if (trimmed === "0d" || trimmed === "0") {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  // US date formats: M/D/YY or M/D/YYYY
  const usDate = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (usDate) {
    const month = usDate[1].padStart(2, "0");
    const day = usDate[2].padStart(2, "0");
    const rawYear = usDate[3];
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    return `${year}-${month}-${day}`;
  }

  // Relative strings: "30d", "7d", "1w", etc.
  try {
    return parseSinceToDate(dateStr);
  } catch {
    verboseLog(`[scatter] could not resolve date "${dateStr}", ignoring\n`);
    return undefined;
  }
}

/**
 * Execute parallel scatter search across all patterns in the plan.
 * Returns deduplicated results, preserving the best FTS5 rank for each message.
 */
export async function scatter(plan: SearchPlan, db: SqliteDatabase): Promise<SearchResult[]> {
  // Filter out empty patterns and validate
  const validPatterns = plan.patterns.filter((p) => p && p.trim().length > 0);

  // Resolve relative dates (e.g. "30d" → "2026-02-09") before passing to SQL
  const afterDate = resolveDate(plan.afterDate);
  const beforeDate = resolveDate(plan.beforeDate);

  verboseLog(`[scatter] executing ${validPatterns.length} pattern searches${plan.fromAddress ? ` + filter-only search` : ""}${afterDate ? ` afterDate=${afterDate}` : ""}\n`);

  // Execute all pattern searches in parallel (only if we have valid patterns)
  // Wrap in error handling to skip patterns that cause FTS5 syntax errors
  const searches = validPatterns.map(async (pattern) => {
    try {
      return await searchWithMeta(db, {
        query: pattern.trim(),
        fromAddress: plan.fromAddress,
        toAddress: plan.toAddress,
        afterDate,
        beforeDate,
        includeNoise: plan.includeNoise,
        limit: 100,
      });
    } catch (error) {
      // Skip patterns that cause FTS5 syntax errors
      verboseLog(`[scatter] skipping pattern "${pattern.trim()}" due to FTS5 error: ${error instanceof Error ? error.message : String(error)}\n`);
      return { results: [], timings: { totalMs: 0 }, totalMatched: 0 };
    }
  });

  // Also run filter-only search if:
  // 1. We have fromAddress set (domain/sender filter — catches all mail from that address regardless of body content)
  // 2. We have no patterns (date-only queries like "today")
  if (plan.fromAddress || validPatterns.length === 0) {
    searches.push(
      searchWithMeta(db, {
        fromAddress: plan.fromAddress,
        toAddress: plan.toAddress,
        afterDate,
        beforeDate,
        includeNoise: plan.includeNoise,
        limit: 200,
      })
    );
  }

  // Execute all searches in parallel
  const results = await Promise.all(searches);

  // Deduplicate by messageId, preserving best FTS5 rank (lower rank = better match)
  const seen = new Map<string, SearchResult>();
  let totalHits = 0;

  for (const result of results) {
    totalHits += result.results.length;
    for (const msg of result.results) {
      const existing = seen.get(msg.messageId);
      if (!existing) {
        seen.set(msg.messageId, msg);
      } else {
        // Keep the message with the better (lower) rank
        // FTS5 ranks are negative; more negative = better
        const existingRank = existing.rank ?? 0;
        const newRank = msg.rank ?? 0;
        if (newRank < existingRank) {
          seen.set(msg.messageId, msg);
        }
      }
    }
  }

  const deduplicated = Array.from(seen.values());
  verboseLog(`[scatter] found ${totalHits} total hits, ${deduplicated.length} unique messages after deduplication\n`);

  return deduplicated;
}
