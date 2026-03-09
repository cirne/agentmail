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
 * 
 * Note: Currently, thread_id is set to message_id (single-message threads).
 * This is a temporary implementation until proper conversation threading is implemented.
 * 
 * @param db Database instance
 * @param parsed Parsed message data
 * @param mailbox Mailbox/folder name
 * @param uid UID from IMAP (or 0 for rebuild from EML)
 * @param labels JSON string of labels array (or "[]" for rebuild)
 * @param rawPath Relative path to raw email file in maildir
 */
export function persistMessage(
  db: SqliteDatabase,
  parsed: ParsedMessage,
  mailbox: string,
  uid: number,
  labels: string,
  rawPath: string
): void {
  // Currently, thread_id = message_id (single-message threads)
  // TODO: Implement proper conversation threading based on In-Reply-To/References headers
  const threadId = parsed.messageId;

  // Check labels for Gmail noise categories: Promotions, Social, Forums, Spam
  // Note: We exclude "Updates" category as it contains important transactional emails (bills, receipts, confirmations)
  let labelIsNoise = false;
  try {
    const labelsArray = JSON.parse(labels) as string[];
    if (Array.isArray(labelsArray)) {
      const noiseLabels = [
        "promotions", "\\promotions",
        "social", "\\social",
        "forums", "\\forums",
        "spam", "\\spam",
        "junk", "\\junk",
        "bulk"
      ];
      labelIsNoise = labelsArray.some(label => 
        noiseLabels.includes(label.toLowerCase())
      );
    }
  } catch {
    // Invalid JSON or not an array - ignore, use header-based detection only
  }

  // Final noise flag: header-based OR label-based
  const isNoise = parsed.isNoise || labelIsNoise ? 1 : 0;

  // Insert message
  db.prepare(
    `INSERT INTO messages (
      message_id, thread_id, folder, uid, labels, is_noise, from_address, from_name,
      to_addresses, cc_addresses, subject, date, body_text, raw_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    rawPath,
  );

  // Insert/update thread
  // Note: participant_count and message_count are both 1 for single-message threads
  // This will need to be updated when proper threading is implemented
  db.prepare(
    `INSERT OR REPLACE INTO threads (thread_id, subject, participant_count, message_count, last_message_at)
     VALUES (?, ?, 1, 1, ?)`
  ).run(threadId, parsed.subject, parsed.date);
}

/**
 * Persist attachments from parsed message data (sync path).
 * Writes attachment files to disk and inserts records into database.
 * 
 * @param db Database instance
 * @param messageId Message ID
 * @param attachments Array of parsed attachments
 * @param maildirPath Base maildir path (defaults to config.maildirPath)
 */
export function persistAttachmentsFromParsed(
  db: SqliteDatabase,
  messageId: string,
  attachments: Array<{ filename: string; content: Buffer; mimeType: string; size: number }>,
  maildirPath?: string
): void {
  if (attachments.length === 0) return;

  const basePath = maildirPath ?? config.maildirPath;
  const attachmentsDir = join(basePath, "attachments", messageId);
  mkdirSync(attachmentsDir, { recursive: true });

  for (const att of attachments) {
    const uniqueFilename = ensureUniqueFilename(attachmentsDir, att.filename);
    const attachmentPath = join(attachmentsDir, uniqueFilename);
    writeFileSync(attachmentPath, att.content, "binary");

    const storedPath = join("attachments", messageId, uniqueFilename);
    db.prepare(
      `INSERT INTO attachments (message_id, filename, mime_type, size, stored_path, extracted_text)
       VALUES (?, ?, ?, ?, ?, NULL)`
    ).run(messageId, att.filename, att.mimeType, att.size, storedPath);
  }
}

/**
 * Persist attachments from existing files on disk (rebuild path).
 * Reads attachment files from disk and inserts records into database.
 * 
 * @param db Database instance
 * @param messageId Message ID
 * @param attachmentsBasePath Base path to attachments directory
 */
export function persistAttachmentsFromDisk(
  db: SqliteDatabase,
  messageId: string,
  attachmentsBasePath: string
): void {
  const attachmentDir = join(attachmentsBasePath, messageId);
  try {
    const attachmentFiles = readdirSync(attachmentDir, { withFileTypes: true }).filter((f) => f.isFile());
    for (const attFile of attachmentFiles) {
      const attPath = join(attachmentDir, attFile.name);
      const stats = statSync(attPath);
      const storedPath = join("attachments", messageId, attFile.name);

      // Try to infer MIME type from extension (best effort)
      const ext = attFile.name.split(".").pop()?.toLowerCase() || "";
      const mimeType = getMimeType(ext);

      db.prepare(
        `INSERT INTO attachments (message_id, filename, mime_type, size, stored_path, extracted_text)
         VALUES (?, ?, ?, ?, ?, NULL)`
      ).run(messageId, attFile.name, mimeType, stats.size, storedPath);
    }
  } catch {
    // Attachment directory doesn't exist or can't be read — skip (attachments optional)
  }
}
