/**
 * Shared message persistence helpers for sync and rebuild operations.
 * Centralizes message and thread insertion logic to prevent drift between ingestion paths.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { SqliteDatabase } from "~/db";
import type { ParsedMessage } from "~/sync/parse-message";
import { config } from "~/lib/config";

/**
 * Sanitize filename for filesystem safety.
 */
function sanitizeFilename(filename: string): string {
  return filename.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/\.\./g, "_");
}

/**
 * Ensure filename is unique in the given directory by appending counter if needed.
 */
function ensureUniqueFilename(dir: string, baseFilename: string): string {
  const sanitized = sanitizeFilename(baseFilename);
  let candidate = sanitized;
  let counter = 1;

  while (existsSync(join(dir, candidate))) {
    const ext = candidate.includes(".") ? candidate.substring(candidate.lastIndexOf(".")) : "";
    const nameWithoutExt = ext ? candidate.substring(0, candidate.lastIndexOf(".")) : candidate;
    candidate = `${nameWithoutExt}_${counter}${ext}`;
    counter++;
  }

  return candidate;
}

/**
 * Best-effort MIME type inference from file extension.
 */
function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    txt: "text/plain",
    html: "text/html",
    csv: "text/csv",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    zip: "application/zip",
  };
  return mimeTypes[ext.toLowerCase()] || "application/octet-stream";
}

/**
 * Insert a message and its associated thread row into the database.
 */
export async function persistMessage(
  db: SqliteDatabase,
  parsed: ParsedMessage,
  mailbox: string,
  uid: number,
  labels: string,
  rawPath: string
): Promise<void> {
  const threadId = parsed.messageId;

  let labelIsNoise = false;
  try {
    const labelsArray = JSON.parse(labels) as string[];
    if (Array.isArray(labelsArray)) {
      labelIsNoise = labelsArray.some((label) => {
        const lower = label.toLowerCase();
        if (
          ["promotions", "\\promotions", "social", "\\social", "forums", "\\forums", "spam", "\\spam", "junk", "\\junk", "bulk"].includes(
            lower
          )
        )
          return true;
        if (lower.startsWith("[superhuman]/ai/")) {
          const category = lower.slice("[superhuman]/ai/".length);
          return ["marketing", "news", "social", "pitch"].includes(category);
        }
        return false;
      });
    }
  } catch {
    // ignore
  }

  const isNoise = parsed.isNoise || labelIsNoise ? 1 : 0;

  await (
    await db.prepare(
      `INSERT INTO messages (
      message_id, thread_id, folder, uid, labels, is_noise, from_address, from_name,
      to_addresses, cc_addresses, subject, date, body_text, raw_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
  ).run(
    parsed.messageId,
    threadId,
    mailbox,
    uid,
    labels,
    isNoise,
    parsed.fromAddress,
    parsed.fromName,
    JSON.stringify(parsed.toAddresses),
    JSON.stringify(parsed.ccAddresses),
    parsed.subject,
    parsed.date,
    parsed.bodyText,
    rawPath
  );

  await (
    await db.prepare(
      `INSERT OR REPLACE INTO threads (thread_id, subject, participant_count, message_count, last_message_at)
     VALUES (?, ?, 1, 1, ?)`
    )
  ).run(threadId, parsed.subject, parsed.date);
}

/**
 * Persist attachments from parsed message data (sync path).
 */
export async function persistAttachmentsFromParsed(
  db: SqliteDatabase,
  messageId: string,
  attachments: Array<{ filename: string; content: Buffer; mimeType: string; size: number }>,
  maildirPath?: string
): Promise<void> {
  if (attachments.length === 0) return;

  const basePath = maildirPath ?? config.maildirPath;
  const attachmentsDir = join(basePath, "attachments", messageId);
  mkdirSync(attachmentsDir, { recursive: true });

  for (const att of attachments) {
    const uniqueFilename = ensureUniqueFilename(attachmentsDir, att.filename);
    const attachmentPath = join(attachmentsDir, uniqueFilename);
    writeFileSync(attachmentPath, att.content, "binary");

    const storedPath = join("attachments", messageId, uniqueFilename);
    await (
      await db.prepare(
        `INSERT INTO attachments (message_id, filename, mime_type, size, stored_path, extracted_text)
       VALUES (?, ?, ?, ?, ?, NULL)`
      )
    ).run(messageId, att.filename, att.mimeType, att.size, storedPath);
  }
}

/**
 * Persist attachments from existing files on disk (rebuild path).
 */
export async function persistAttachmentsFromDisk(
  db: SqliteDatabase,
  messageId: string,
  attachmentsBasePath: string
): Promise<void> {
  const attachmentDir = join(attachmentsBasePath, messageId);
  try {
    const attachmentFiles = readdirSync(attachmentDir, { withFileTypes: true }).filter((f) => f.isFile());
    for (const attFile of attachmentFiles) {
      const attPath = join(attachmentDir, attFile.name);
      const stats = statSync(attPath);
      const storedPath = join("attachments", messageId, attFile.name);

      const ext = attFile.name.split(".").pop()?.toLowerCase() || "";
      const mimeType = getMimeType(ext);

      await (
        await db.prepare(
          `INSERT INTO attachments (message_id, filename, mime_type, size, stored_path, extracted_text)
         VALUES (?, ?, ?, ?, ?, NULL)`
        )
      ).run(messageId, attFile.name, mimeType, stats.size, storedPath);
    }
  } catch {
    // Attachment directory doesn't exist or can't be read — skip
  }
}
