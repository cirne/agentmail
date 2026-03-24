import type { SearchResult } from "~/lib/types";

/** Above this many results, JSON search defaults to slim rows (unless overridden). */
export const SEARCH_AUTO_SLIM_THRESHOLD = 50;

export type SearchResultJsonFormat = "slim" | "full";

export type SearchResultFormatPreference = "auto" | "full" | "slim";

/**
 * Choose slim vs full for CLI/MCP JSON search output.
 * Auto-slim only when allowed (default headers projection, no custom --fields).
 */
export function resolveSearchJsonFormat(opts: {
  resultCount: number;
  preference: SearchResultFormatPreference;
  allowAutoSlim: boolean;
}): SearchResultJsonFormat {
  const { resultCount, preference, allowAutoSlim } = opts;
  if (preference === "slim") return "slim";
  if (preference === "full") return "full";
  if (!allowAutoSlim) return "full";
  return resultCount > SEARCH_AUTO_SLIM_THRESHOLD ? "slim" : "full";
}

/**
 * Slim search row for triage: messageId, subject, fromName?, date, attachments (count only).
 */
export function searchResultToSlimJsonRow(r: SearchResult): Record<string, unknown> {
  const out: Record<string, unknown> = {
    messageId: r.messageId,
    subject: r.subject,
    date: r.date,
  };
  if (r.fromName != null && r.fromName !== "") {
    out.fromName = r.fromName;
  }
  const attCount = r.attachments?.length ?? 0;
  if (attCount > 0) {
    out.attachments = attCount;
  }
  return out;
}

/** Slim row from CLI search row (attachment count from hydrate step). */
export function searchCliRowToSlimJsonRow(row: {
  messageId: string;
  subject: string;
  fromName: string | null;
  date: string;
  attachments?: { count: number };
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    messageId: row.messageId,
    subject: row.subject,
    date: row.date,
  };
  if (row.fromName != null && row.fromName !== "") {
    out.fromName = row.fromName;
  }
  const c = row.attachments?.count ?? 0;
  if (c > 0) {
    out.attachments = c;
  }
  return out;
}

export function searchSlimResultHint(): string {
  return (
    "Large result set — slim format (messageId, subject, fromName, date, attachments count only). " +
    "Use get_messages(messageIds) with detail: 'summary' or 'full' for bodyPreview, threadId, fromAddress, rank, and attachment types."
  );
}
