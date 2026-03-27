import { readFileSync } from "fs";
import { join } from "path";
import { simpleParser } from "mailparser";
import type { SqliteDatabase } from "~/db";

/** Match DB/message_id storage: angle brackets. */
export function normalizeMessageId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return id;
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed;
  return `<${trimmed}>`;
}

export interface ThreadingHeaders {
  inReplyTo: string;
  references: string;
}

/**
 * Load In-Reply-To and References from the source message's raw .eml for reply threading.
 */
export async function loadThreadingFromSourceMessage(
  db: SqliteDatabase,
  maildirPath: string,
  sourceMessageId: string
): Promise<ThreadingHeaders> {
  const mid = normalizeMessageId(sourceMessageId);
  const row = (await (
    await db.prepare("SELECT raw_path, message_id FROM messages WHERE message_id = ?")
  ).get(mid)) as { raw_path: string; message_id: string } | undefined;

  if (!row) {
    throw new Error(`Message not found in index: ${sourceMessageId}`);
  }

  const abs = join(maildirPath, row.raw_path);
  const buf = readFileSync(abs);
  const parsed = await simpleParser(buf);

  const ensureBrackets = (id: string): string => {
    const t = id.trim();
    if (t.startsWith("<") && t.endsWith(">")) return t;
    return `<${t}>`;
  };

  const origId = parsed.messageId ? ensureBrackets(parsed.messageId) : row.message_id;

  const inReplyTo = origId;

  const prevRefs = parsed.references;
  let refsParts: string[] = [];
  if (Array.isArray(prevRefs)) {
    refsParts = prevRefs.map((r) => ensureBrackets(String(r)));
  } else if (typeof prevRefs === "string" && prevRefs.trim()) {
    refsParts = prevRefs.trim().split(/\s+/).map(ensureBrackets);
  }
  if (!refsParts.includes(origId)) {
    refsParts.push(origId);
  }
  const references = refsParts.join(" ");

  return {
    inReplyTo,
    references,
  };
}
