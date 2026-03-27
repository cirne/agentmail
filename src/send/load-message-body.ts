import { readFileSync } from "fs";
import { join } from "path";
import { simpleParser } from "mailparser";
import type { AddressObject } from "mailparser";
import type { SqliteDatabase } from "~/db";
import { normalizeMessageId } from "./threading";

export interface ForwardSourceExcerpt {
  fromLine: string;
  dateLine: string;
  subjectLine: string;
  bodyText: string;
}

function formatFromField(from: AddressObject | AddressObject[] | undefined): string {
  if (!from) return "(unknown)";
  const blocks = Array.isArray(from) ? from : [from];
  const first = blocks[0]?.value?.[0];
  if (!first) return "(unknown)";
  if (first.name && first.address) return `${first.name} <${first.address}>`;
  return first.address ?? "(unknown)";
}

function htmlToPlainFallback(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function htmlFieldToString(html: unknown): string {
  if (typeof html === "string") return html;
  if (html == null) return "";
  return String(html);
}

/**
 * Load plain body and metadata from the raw maildir file for a message id in the index.
 * Used to build forward drafts with an inlined quoted original.
 */
export async function loadForwardSourceExcerpt(
  db: SqliteDatabase,
  maildirPath: string,
  sourceMessageId: string
): Promise<ForwardSourceExcerpt> {
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

  let bodyText = (parsed.text ?? "").trim();
  if (!bodyText) {
    const htmlStr = htmlFieldToString(parsed.html);
    if (htmlStr) {
      bodyText = htmlToPlainFallback(htmlStr);
    }
  }

  return {
    fromLine: formatFromField(parsed.from),
    dateLine: parsed.date ? parsed.date.toUTCString() : "",
    subjectLine: parsed.subject ?? "",
    bodyText,
  };
}

const FWD_SEP = "---------- Forwarded message ---------";

/**
 * Combine optional user preamble with a standard forwarded-message block.
 */
export function composeForwardDraftBody(preamble: string, excerpt: ForwardSourceExcerpt): string {
  const pre = preamble.replace(/\r\n/g, "\n").trimEnd();
  const lines: string[] = [];
  if (pre) {
    lines.push(pre);
    lines.push("");
  }
  lines.push(FWD_SEP);
  lines.push(`From: ${excerpt.fromLine}`);
  if (excerpt.dateLine) lines.push(`Date: ${excerpt.dateLine}`);
  if (excerpt.subjectLine) lines.push(`Subject: ${excerpt.subjectLine}`);
  lines.push("");
  lines.push(excerpt.bodyText || "(no body text)");
  return lines.join("\n");
}
