/**
 * Rebuild database index from existing EML files in maildir.
 * Used when schema version changes — faster than re-syncing from IMAP.
 *
 * Parse (CPU-heavy) may run on worker threads; SQLite writes stay on the main thread in one
 * transaction with reused prepared statements.
 */

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { config } from "~/lib/config";
import { getDb } from "./index";
import { logger } from "~/lib/logger";
import {
  persistMessage,
  persistAttachmentsFromDisk,
  persistAttachmentsFromParsed,
  prepareMessagePersistStatements,
} from "./message-persistence";
import { getRebuildParseConcurrency, parseMaildirJobsWithPool } from "./rebuild-parse-pool";
import type { MaildirParseJob } from "./rebuild-parse-job";

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

  const files = readdirSync(maildirCurPath).filter((f) => f.endsWith(".eml"));
  const parseConcurrency = getRebuildParseConcurrency();
  logger.info("Reindexing from maildir", { fileCount: files.length, mailbox, workerConcurrency: parseConcurrency });

  const jobs: MaildirParseJob[] = [];
  let failed = 0;

  for (const filename of files) {
    const filePath = join(maildirCurPath, filename);
    const uid = extractUidFromFilename(filename);

    if (uid === null) {
      logger.debug("Skipping file with invalid UID format", { filename });
      failed++;
      continue;
    }

    jobs.push({
      filePath,
      filename,
      uid,
      relPath: join("cur", filename),
    });
  }

  const parseResults = await parseMaildirJobsWithPool(jobs, parseConcurrency);

  const stmts = await prepareMessagePersistStatements(db);
  const insertAtt = stmts.insertAttachment;

  let parsed = 0;
  let earliestDate: string | null = null;
  let latestDate: string | null = null;

  await db.exec("BEGIN IMMEDIATE");
  try {
    for (let i = 0; i < parseResults.length; i++) {
      const result = parseResults[i]!;

      if (!result.ok) {
        logger.warn("Failed to parse message during reindex", {
          filename: result.filename,
          error: result.error,
        });
        failed++;
        continue;
      }

      const { parsedMsg, labelsJson, relPath, uid } = result;

      const { inserted } = await persistMessage(db, parsedMsg, mailbox, uid, labelsJson, relPath, {
        mode: "insertOrIgnore",
        statements: stmts,
      });

      if (!inserted) {
        logger.debug("Skipping duplicate message", { messageId: parsedMsg.messageId });
        continue;
      }

      if (parsedMsg.attachments.length > 0) {
        await persistAttachmentsFromParsed(db, parsedMsg.messageId, parsedMsg.attachments, {
          insertAttachment: insertAtt,
        });
      } else {
        await persistAttachmentsFromDisk(db, parsedMsg.messageId, attachmentsBasePath, {
          insertAttachment: insertAtt,
        });
      }

      parsed++;
      if (!earliestDate || parsedMsg.date < earliestDate) earliestDate = parsedMsg.date;
      if (!latestDate || parsedMsg.date > latestDate) latestDate = parsedMsg.date;
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

    await db.exec("COMMIT");
  } catch (err) {
    await db.exec("ROLLBACK");
    throw err;
  }

  logger.info("Reindex complete", { parsed, failed, mailbox });
  return { parsed, failed };
}
