/**
 * Shared message extraction helpers for lean/summary JSON responses.
 * Used by MCP get_messages, get_message, and get_thread to strip noise fields,
 * normalize to_addresses/cc_addresses/labels, and omit empty values for token savings.
 */

/** Parse to_addresses/cc_addresses from DB (JSON string or already array) to string[]. */
export function parseJsonArray(value: unknown): string[] {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value.map(String);
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    return [String(value)];
  }
}

/** Parse labels from DB (may be double-encoded JSON string) to string[]. */
export function parseLabels(value: unknown): string[] {
  if (value == null || value === "") return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    return [String(value)];
  }
}

/** Default max body chars for lean responses (get_thread, search top result, get_message/get_messages). */
export const DEFAULT_BODY_CAP = 2000;

/** Same as DEFAULT_BODY_CAP; alias for get_message/get_messages param default. */
export const DEFAULT_MAX_BODY_CHARS = DEFAULT_BODY_CAP;

/** Max body chars cap (get_messages maxBodyChars is clamped to this). */
export const MAX_BODY_CHARS_CAP = 50000;

/** Snippet length for detail: "summary" (get_messages). */
export const SUMMARY_SNIPPET_LEN = 200;

/** Shaped message from formatMessageForOutput (non-raw) — minimal type for lean/summary conversion. */
export interface ShapedMessageLike {
  message_id: string;
  thread_id: string;
  from_address: string;
  from_name: string | null;
  to_addresses: unknown;
  cc_addresses: unknown;
  subject: string;
  date: string;
  content?: { markdown?: string };
  attachments: unknown;
  labels?: unknown;
}

/**
 * Returns a new object with keys removed where value is empty (null, undefined, "", or []).
 * Used to save tokens when serializing lean/summary message output.
 */
export function omitEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/** Convert shaped message to lean response (strip noise, body truncated at cap, omit empty). */
export function toLeanMessage(msg: ShapedMessageLike, bodyCap: number): Record<string, unknown> {
  const content = msg.content as { markdown?: string } | undefined;
  const bodyText = (content?.markdown ?? "").trim();
  const truncated = bodyText.length > bodyCap;
  const markdown = bodyText.slice(0, bodyCap);

  const to = parseJsonArray(msg.to_addresses);
  const cc = parseJsonArray(msg.cc_addresses);
  const labels = parseLabels(msg.labels);
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];

  const raw: Record<string, unknown> = {
    message_id: msg.message_id,
    thread_id: msg.thread_id,
    from_address: msg.from_address,
    subject: msg.subject,
    date: msg.date,
    to_addresses: to,
    cc_addresses: cc,
    labels,
    attachments,
  };
  if (markdown) raw.content = { markdown };
  if (msg.from_name != null && msg.from_name !== "") raw.from_name = msg.from_name;
  if (truncated) raw.bodyTruncated = true;

  return omitEmpty(raw);
}

/** Convert shaped message to summary response (minimal fields + snippet, omit empty). */
export function toSummaryMessage(msg: ShapedMessageLike): Record<string, unknown> {
  const content = msg.content as { markdown?: string } | undefined;
  const bodyText = (content?.markdown ?? "").trim();
  const snippet = bodyText.slice(0, SUMMARY_SNIPPET_LEN);
  const from = msg.from_name ? `${msg.from_name} <${msg.from_address}>` : msg.from_address;
  const to = parseJsonArray(msg.to_addresses);

  const raw: Record<string, unknown> = {
    message_id: msg.message_id,
    subject: msg.subject,
    from,
    date: msg.date,
    snippet: snippet + (bodyText.length > SUMMARY_SNIPPET_LEN ? "…" : ""),
  };
  if (to.length > 0) raw.to = to;

  return omitEmpty(raw);
}

/** Detail mode for get_message / get_messages (single source of truth). */
export type GetMessageDetail = "full" | "summary" | "raw";

/**
 * Convert shaped messages (from formatMessageForOutput) to the JSON output used by
 * get_message and get_messages. Shared so both tools use the same logic and params.
 */
export function shapeShapedToOutput(
  shaped: (ShapedMessageLike | Record<string, unknown>)[],
  options: { useRaw: boolean; detail?: GetMessageDetail; maxBodyChars?: number }
): Record<string, unknown>[] {
  if (options.useRaw) return shaped as Record<string, unknown>[];
  if (options.detail === "summary") return shaped.map((m) => toSummaryMessage(m as ShapedMessageLike));
  const cap = Math.max(0, Math.min(options.maxBodyChars ?? DEFAULT_BODY_CAP, MAX_BODY_CHARS_CAP));
  return shaped.map((m) => toLeanMessage(m as ShapedMessageLike, cap));
}
