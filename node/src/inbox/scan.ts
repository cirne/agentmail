import OpenAI from "openai";
import type { RefreshPreviewRow } from "~/lib/refresh-preview";
import { config } from "~/lib/config";
import type { SqliteDatabase } from "~/db";
import { indexAttachmentsByMessageId, type AttachmentIndexedByFilename } from "~/attachments/list-for-message";
import {
  inboxCandidatePrefetchLimit,
  sortRowsBySenderContactRank,
} from "~/search/owner-contact-stats";

type InboxCandidate = {
  messageId: string;
  date: string;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  snippet: string;
  attachments: AttachmentIndexedByFilename[];
};

const DEFAULT_CANDIDATE_CAP = 80;
const DEFAULT_NOTABLE_CAP = 10;
const DEFAULT_BATCH_SIZE = 40;

const SYSTEM_PROMPT = `You filter email metadata for a busy user. Return strict JSON only:
{"notable":[{"messageId":"<exact id from input>","note":"<one short line why this matters>"}]}

Include only messages that likely need human attention: personal mail, work decisions, security alerts, bills or invoices needing action, deadlines, direct questions to the user.

Exclude: marketing, newsletters, routine noreply/automated mail, social digests, generic "your order shipped" unless time-sensitive, obvious spam patterns.

If nothing qualifies, return {"notable":[]}. Every messageId in notable MUST appear exactly in the user JSON array.`;

function stripSnippetHtml(snippet: string): string {
  return snippet.replace(/<[^>]+>/g, "").trim();
}

async function defaultClassifyBatch(
  batch: InboxCandidate[]
): Promise<Array<{ messageId: string; note?: string }>> {
  if (batch.length === 0) return [];

  const apiKey = config.openai.apiKey;
  const client = new OpenAI({ apiKey });

  const payload = batch.map((c) => ({
    messageId: c.messageId,
    date: c.date,
    from: c.fromName ? `${c.fromName} <${c.fromAddress}>` : c.fromAddress,
    subject: c.subject,
    snippet: c.snippet.slice(0, 400),
    ...(c.attachments.length > 0
      ? {
          attachments: c.attachments.map((a) => ({ filename: a.filename, mimeType: a.mimeType })),
        }
      : {}),
  }));

  const completion = await client.chat.completions.create({
    model: "gpt-4.1-nano",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(payload) },
    ],
  });

  const text = completion.choices[0]?.message?.content?.trim() ?? "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as { notable?: unknown };
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !("notable" in parsed)) return [];
  const notable = (parsed as { notable: unknown }).notable;
  if (!Array.isArray(notable)) return [];

  const allowed = new Set(batch.map((b) => b.messageId));
  const out: Array<{ messageId: string; note?: string }> = [];
  for (const item of notable) {
    if (!item || typeof item !== "object") continue;
    const mid = (item as { messageId?: string }).messageId;
    if (typeof mid !== "string" || !allowed.has(mid)) continue;
    const note = (item as { note?: string }).note;
    out.push({
      messageId: mid,
      ...(typeof note === "string" && note.trim() ? { note: note.trim() } : {}),
    });
  }
  return out;
}

export type RunInboxScanOptions = {
  cutoffIso: string;
  includeNoise: boolean;
  /** Mailbox owner (IMAP user). When set, candidates are ordered by sender contact rank before LLM batches. */
  ownerAddress?: string;
  candidateCap?: number;
  notableCap?: number;
  batchSize?: number;
  /** Override LLM (tests). */
  classifyBatch?: (
    batch: InboxCandidate[]
  ) => Promise<Array<{ messageId: string; note?: string }>>;
};

export async function runInboxScan(
  db: SqliteDatabase,
  options: RunInboxScanOptions
): Promise<{
  newMail: RefreshPreviewRow[];
  candidatesScanned: number;
  llmDurationMs: number;
}> {
  const candidateCap = options.candidateCap ?? DEFAULT_CANDIDATE_CAP;
  const notableCap = options.notableCap ?? DEFAULT_NOTABLE_CAP;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const classify = options.classifyBatch ?? defaultClassifyBatch;

  const noiseSql = options.includeNoise ? "" : " AND is_noise = 0";
  const fetchLimit = inboxCandidatePrefetchLimit(candidateCap);

  const rows = (await (
    await db.prepare(
      /* sql */ `
      SELECT message_id AS messageId, from_address AS fromAddress, from_name AS fromName, subject, date,
        COALESCE(TRIM(SUBSTR(body_text, 1, 200)), '') || (CASE WHEN LENGTH(TRIM(body_text)) > 200 THEN '…' ELSE '' END) AS snippet
      FROM messages
      WHERE date >= ?${noiseSql}
      ORDER BY date DESC
      LIMIT ?
    `
    )
  ).all(options.cutoffIso, fetchLimit)) as Array<{
    messageId: string;
    fromAddress: string;
    fromName: string | null;
    subject: string;
    date: string;
    snippet: string;
  }>;

  const attMap = await indexAttachmentsByMessageId(
    db,
    rows.map((r) => r.messageId)
  );
  let candidates: InboxCandidate[] = rows.map((r) => ({
    messageId: r.messageId,
    date: r.date,
    fromAddress: r.fromAddress,
    fromName: r.fromName,
    subject: r.subject,
    snippet: stripSnippetHtml(r.snippet),
    attachments: attMap.get(r.messageId) ?? [],
  }));

  candidates = await sortRowsBySenderContactRank(db, options.ownerAddress, candidates);
  candidates = candidates.slice(0, candidateCap);

  const byId = new Map(candidates.map((c) => [c.messageId, c]));
  let llmDurationMs = 0;
  const mergedOrder: Array<{ messageId: string; note?: string }> = [];
  const seen = new Set<string>();

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const t0 = Date.now();
    const picks = await classify(batch);
    llmDurationMs += Date.now() - t0;
    for (const p of picks) {
      if (seen.has(p.messageId)) continue;
      seen.add(p.messageId);
      mergedOrder.push(p);
      if (mergedOrder.length >= notableCap) break;
    }
    if (mergedOrder.length >= notableCap) break;
  }

  const newMail: RefreshPreviewRow[] = [];
  for (const p of mergedOrder.slice(0, notableCap)) {
    const c = byId.get(p.messageId);
    if (!c) continue;
    newMail.push({
      messageId: c.messageId,
      date: c.date,
      fromAddress: c.fromAddress,
      fromName: c.fromName,
      subject: c.subject,
      snippet: c.snippet,
      ...(p.note ? { note: p.note } : {}),
      ...(c.attachments.length > 0 ? { attachments: c.attachments } : {}),
    });
  }

  return {
    newMail,
    candidatesScanned: candidates.length,
    llmDurationMs,
  };
}
