import type { SearchResult, SearchResultAttachment } from "~/lib/types";

function mimeTypeToExtension(mimeType: string): string {
  const parts = mimeType.split("/");
  return parts.length > 1 ? parts[1]! : mimeType;
}

function distinctAttachmentTypeExtensions(attachments: SearchResultAttachment[]): string[] {
  return [...new Set(attachments.map((a) => mimeTypeToExtension(a.mimeType)))];
}

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
 * Slim search row for triage: messageId, subject, fromName?, date, attachments (count), attachmentTypes (MIME subtype strings).
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
  const atts = r.attachments ?? [];
  if (atts.length > 0) {
    out.attachments = atts.length;
    const types = distinctAttachmentTypeExtensions(atts);
    if (types.length > 0) {
      out.attachmentTypes = types;
    }
  }
  return out;
}

/** Slim row from CLI search row (aggregates from attachmentList). */
export function searchCliRowToSlimJsonRow(row: {
  messageId: string;
  subject: string;
  fromName: string | null;
  date: string;
  attachmentList: SearchResultAttachment[];
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    messageId: row.messageId,
    subject: row.subject,
    date: row.date,
  };
  if (row.fromName != null && row.fromName !== "") {
    out.fromName = row.fromName;
  }
  const atts = row.attachmentList;
  if (atts.length > 0) {
    out.attachments = atts.length;
    const types = distinctAttachmentTypeExtensions(atts);
    if (types.length > 0) {
      out.attachmentTypes = types;
    }
  }
  return out;
}

export function searchSlimResultHint(): string {
  return (
    "Large result set — slim format (messageId, subject, fromName, date, attachment count + attachmentTypes). " +
    "Use get_messages(messageIds) with detail: 'summary' or 'full' for bodyPreview, threadId, fromAddress, rank, and per-file attachment metadata."
  );
}
