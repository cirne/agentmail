/**
 * Rebuild database index from existing EML files in maildir.
 * Used when schema version changes — faster than re-syncing from IMAP.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { config } from "~/lib/config";
import { getDb } from "./index";
import { parseRawMessage } from "~/sync/parse-message";
import { logger } from "~/lib/logger";

/** Get mailbox name (same logic as sync). */
function getSyncMailbox(host: string): string {
  return host.toLowerCase().includes("gmail") ? "[Gmail]/All Mail" : "INBOX";
}

/**
 * Extract UID from filename format: {uid}_{safe_messageId}.eml
 */
function extractUidFromFilename(filename: string): number | null {
  const match = filename.match(/^(\d+)_/);
  if (!match) return null;
  const uid = parseInt(match[1], 10);
  return isNaN(uid) ? null : uid;
}

/**
 * Re-index all messages from maildir/cur/ into the database.
 * Assumes DB is fresh (just created with new schema).
 * Returns count of successfully parsed messages.
 * Uses the global logger (should be configured to file logger during rebuild).
 */
export async function reindexFromMaildir(): Promise<{ parsed: number; failed: number }> {
  const db = getDb();
  const maildirCurPath = join(config.maildirPath, "cur");
  const attachmentsBasePath = join(config.maildirPath, "attachments");

  // Determine folder/mailbox (same as sync)
  const mailbox = config.sync.mailbox || getSyncMailbox(config.imap.host);

  if (!existsSync(config.maildirPath)) {
    logger.warn("maildir not found, skipping reindex");
    return { parsed: 0, failed: 0 };
  }
  if (!readdirSync(config.maildirPath, { withFileTypes: true }).some((d) => d.isDirectory() && d.name === "cur")) {
    logger.warn("maildir/cur/ directory not found, skipping reindex");
    return { parsed: 0, failed: 0 };
  }

  let parsed = 0;
  let failed = 0;
  let earliestDate: string | null = null;
  let latestDate: string | null = null;

  const files = readdirSync(maildirCurPath).filter((f) => f.endsWith(".eml"));
  logger.info("Reindexing from maildir", { fileCount: files.length, mailbox });

  for (const filename of files) {
    const filePath = join(maildirCurPath, filename);
    const uid = extractUidFromFilename(filename);

    if (uid === null) {
      logger.debug("Skipping file with invalid UID format", { filename });
      failed++;
      continue;
    }

    try {
      const raw = readFileSync(filePath);
      const parsedMsg = await parseRawMessage(raw);

      // Check for duplicate (shouldn't happen in fresh DB, but be safe)
      const existing = db.prepare("SELECT 1 FROM messages WHERE message_id = ?").get(parsedMsg.messageId);
      if (existing) {
        logger.debug("Skipping duplicate message", { messageId: parsedMsg.messageId });
        continue;
      }

      const relPath = join("cur", filename);
      const threadId = parsedMsg.messageId;

      // Insert message
      db.prepare(
        `INSERT INTO messages (
          message_id, thread_id, folder, uid, labels, from_address, from_name,
          to_addresses, cc_addresses, subject, date, body_text, raw_path, embedding_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
      ).run(
        parsedMsg.messageId,
        threadId,
        mailbox,
        uid,
        "[]", // Labels not available from EML files alone
        parsedMsg.fromAddress,
        parsedMsg.fromName,
        JSON.stringify(parsedMsg.toAddresses),
        JSON.stringify(parsedMsg.ccAddresses),
        parsedMsg.subject,
        parsedMsg.date,
        parsedMsg.bodyText,
        relPath,
      );

      // Insert/update thread
      db.prepare(
        `INSERT OR REPLACE INTO threads (thread_id, subject, participant_count, message_count, last_message_at)
         VALUES (?, ?, 1, 1, ?)`
      ).run(threadId, parsedMsg.subject, parsedMsg.date);

      // Process attachments if directory exists
      const attachmentDir = join(attachmentsBasePath, parsedMsg.messageId);
      try {
        const attachmentFiles = readdirSync(attachmentDir, { withFileTypes: true }).filter((f) => f.isFile());
        for (const attFile of attachmentFiles) {
          const attPath = join(attachmentDir, attFile.name);
          const stats = statSync(attPath);
          const storedPath = join("attachments", parsedMsg.messageId, attFile.name);

          // Try to infer MIME type from extension (best effort)
          const ext = attFile.name.split(".").pop()?.toLowerCase() || "";
          const mimeType = getMimeType(ext);

          db.prepare(
            `INSERT INTO attachments (message_id, filename, mime_type, size, stored_path, extracted_text)
             VALUES (?, ?, ?, ?, ?, NULL)`
          ).run(parsedMsg.messageId, attFile.name, mimeType, stats.size, storedPath);
        }
      } catch {
        // Attachment directory doesn't exist or can't be read — skip (attachments optional)
      }

      parsed++;
      if (!earliestDate || parsedMsg.date < earliestDate) earliestDate = parsedMsg.date;
      if (!latestDate || parsedMsg.date > latestDate) latestDate = parsedMsg.date;
    } catch (err) {
      logger.warn("Failed to parse message during reindex", {
        filename,
        error: err instanceof Error ? err.message : String(err),
      });
      failed++;
    }
  }

  // Update sync_summary totals
  db.prepare(
    `UPDATE sync_summary SET
      earliest_synced_date = COALESCE(?, earliest_synced_date),
      latest_synced_date = COALESCE(?, latest_synced_date),
      total_messages = (SELECT COUNT(*) FROM messages)
     WHERE id = 1`
  ).run(earliestDate, latestDate);

  logger.info("Reindex complete", { parsed, failed, mailbox });
  return { parsed, failed };
}

/**
 * Simple MIME type inference from file extension.
 * Best-effort only — attachment extraction will handle actual detection.
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
  return mimeTypes[ext] || "application/octet-stream";
}
