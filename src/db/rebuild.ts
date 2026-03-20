/**
 * Rebuild database index from existing EML files in maildir.
 * Used when schema version changes — faster than re-syncing from IMAP.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { config } from "~/lib/config";
import { getDb } from "./index";
import { parseRawMessage } from "~/sync/parse-message";
import { logger } from "~/lib/logger";
import { persistMessage, persistAttachmentsFromDisk, persistAttachmentsFromParsed } from "./message-persistence";
import { readMessageMeta } from "~/lib/message-meta";

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
 */
export async function reindexFromMaildir(): Promise<{ parsed: number; failed: number }> {
  const db = await getDb();
  const maildirCurPath = join(config.maildirPath, "cur");
  const attachmentsBasePath = join(config.maildirPath, "attachments");

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

      const existing = await (await db.prepare("SELECT 1 FROM messages WHERE message_id = ?")).get(parsedMsg.messageId);
      if (existing) {
        logger.debug("Skipping duplicate message", { messageId: parsedMsg.messageId });
        continue;
      }

      const relPath = join("cur", filename);

      const meta = readMessageMeta(filePath);
      const labelsJson = meta.labels?.length ? JSON.stringify(meta.labels) : "[]";

      await persistMessage(db, parsedMsg, mailbox, uid, labelsJson, relPath);

      if (parsedMsg.attachments.length > 0) {
        await persistAttachmentsFromParsed(db, parsedMsg.messageId, parsedMsg.attachments);
      } else {
        await persistAttachmentsFromDisk(db, parsedMsg.messageId, attachmentsBasePath);
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

  await (
    await db.prepare(
      `UPDATE sync_summary SET
      earliest_synced_date = COALESCE(?, earliest_synced_date),
      latest_synced_date = COALESCE(?, latest_synced_date),
      total_messages = (SELECT COUNT(*) FROM messages)
     WHERE id = 1`
    )
  ).run(earliestDate, latestDate);

  logger.info("Reindex complete", { parsed, failed, mailbox });
  return { parsed, failed };
}
