import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { ImapFlow } from "imapflow";
import { config, requireImapConfig } from "~/lib/config";
import { getDb } from "~/db";
import { acquireLock, releaseLock } from "~/lib/process-lock";
import { parseRawMessage } from "./parse-message";
import { parseSinceToDate } from "./parse-since";
import { createFileLogger, generateSyncLogFilename, type FileLogger } from "~/lib/file-logger";

/** Mailbox to sync: All Mail for Gmail (per ADR-011), INBOX for others. */
function getSyncMailbox(host: string): string {
  return host.toLowerCase().includes("gmail") ? "[Gmail]/All Mail" : "INBOX";
}

export interface SyncOptions {
  /** Relative since spec (e.g. 7d, 5w, 3m, 2y). Overrides DEFAULT_SYNC_SINCE env var when set. */
  since?: string;
  /** Sync direction: 'forward' (newest first, for updates) or 'backward' (oldest first, for backfill). Default: 'forward' */
  direction?: 'forward' | 'backward';
  /** Optional callback invoked immediately when log file is created, before sync starts */
  onLogPath?: (logPath: string) => void;
}

export interface SyncResult {
  synced: number;
  messagesFetched: number;
  bytesDownloaded: number;
  durationMs: number;
  bandwidthBytesPerSec: number;
  messagesPerMinute: number;
  logPath: string;
}

const BATCH_SIZE = 50;

function ensureMaildir() {
  const base = config.maildirPath;
  mkdirSync(join(base, "cur"), { recursive: true });
  mkdirSync(join(base, "new"), { recursive: true });
  mkdirSync(join(base, "tmp"), { recursive: true });
  mkdirSync(join(base, "attachments"), { recursive: true });
}

function sanitizeFilename(filename: string): string {
  // Remove or replace unsafe characters for filesystem
  return filename.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/\.\./g, "_");
}

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

function safeFilename(uid: number, messageId: string): string {
  const safe = messageId.replace(/[<>"\\/]/g, "_").slice(0, 80) || "msg";
  return `${uid}_${safe}.eml`;
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(2) + " KB";
  return n + " B";
}

function logSyncMetrics(fileLogger: FileLogger, r: SyncResult): void {
  fileLogger.info("Sync complete", {
    synced: r.synced,
    messagesFetched: r.messagesFetched,
    bytesDownloaded: r.bytesDownloaded,
    durationMs: r.durationMs,
    bandwidthBytesPerSec: Math.round(r.bandwidthBytesPerSec),
    messagesPerMinute: Math.round(r.messagesPerMinute),
  });
  // One-line summary for agents: easy to parse and infer speed
  const durationSec = (r.durationMs / 1000).toFixed(2);
  const bandwidth = formatBytes(r.bandwidthBytesPerSec) + "/s";
  const throughput = Math.round(r.messagesPerMinute) + " msg/min";
  fileLogger.info("Sync metrics", {
    summary: `${r.synced} new, ${r.messagesFetched} fetched | ${formatBytes(r.bytesDownloaded)} down | ${bandwidth} | ${throughput} | ${durationSec}s`,
  });
}

export async function runSync(options?: SyncOptions): Promise<SyncResult> {
  const startTime = Date.now();
  
  // Create file logger for this sync run
  const logFilename = generateSyncLogFilename();
  const fileLogger = createFileLogger(logFilename);
  
  // Notify caller of log path immediately (useful for background execution)
  if (options?.onLogPath) {
    options.onLogPath(fileLogger.logPath);
  }
  
  const imap = requireImapConfig();
  if (!imap.user || !imap.password) {
    fileLogger.close();
    throw new Error("IMAP_USER and IMAP_PASSWORD are required for sync. Set them in .env");
  }

  const sinceSpec = options?.since ?? config.sync.defaultSince;
  const fromDate = parseSinceToDate(sinceSpec);
  fileLogger.info("Sync starting", { user: imap.user, fromDate });

  ensureMaildir();
  const db = getDb();

  const sinceDate = new Date(fromDate + "T00:00:00Z");
  if (isNaN(sinceDate.getTime())) {
    throw new Error(`Invalid from date: ${fromDate}. Use --since 7d, 5w, 3m, 2y or set DEFAULT_SYNC_SINCE env var.`);
  }

  // Acquire lock with PID-based ownership
  const lockResult = acquireLock(db, "sync_summary", process.pid);
  if (!lockResult.acquired) {
    fileLogger.info("Sync already running, exiting");
    fileLogger.close();
    const durationMs = Date.now() - startTime;
    return {
      synced: 0,
      messagesFetched: 0,
      bytesDownloaded: 0,
      durationMs,
      bandwidthBytesPerSec: 0,
      messagesPerMinute: 0,
      logPath: fileLogger.logPath,
    };
  }
  if (lockResult.takenOver) {
    // Partial work is safe: sync_state.last_uid is correct,
    // and message dedup prevents re-inserts
    fileLogger.info("Recovered from crashed sync, resuming from last checkpoint");
  }

  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.port === 993,
    auth: { user: imap.user, pass: imap.password },
    logger: false, // Keep sync output minimal; our logger reports start/complete/count
    connectionTimeout: 10000, // 10s to establish connection
    // NOTE: do not set socketTimeout — causes a segfault in Bun v1.1.38 on TLS sockets.
    // Use JS-level Promise.race timeout around fetchAll instead (see below).
  });

  try {
    await client.connect();
    fileLogger.info("IMAP connected", { host: imap.host });

    const mailbox = config.sync.mailbox || getSyncMailbox(imap.host);
  const excludeLabels = config.sync.excludeLabels; // lowercase
    const lock = await client.getMailboxLock(mailbox);
    try {
      const mailboxObj = client.mailbox;
      const uidvalidity = mailboxObj && typeof mailboxObj === "object" ? Number(mailboxObj.uidValidity ?? 0) : 0;
      
      // Incremental sync (ADR-003): use UID range search when we have a checkpoint
      // This avoids fetching all UIDs since a date and filtering client-side
      const stateRow = db.prepare("SELECT uidvalidity, last_uid FROM sync_state WHERE folder = ?").get(mailbox) as
        | { uidvalidity: number | bigint; last_uid: number | bigint }
        | undefined;
      // Normalize to numbers (SQLite may return BigInt)
      const state = stateRow ? {
        uidvalidity: Number(stateRow.uidvalidity),
        last_uid: Number(stateRow.last_uid),
      } : undefined;
      
      const direction = options?.direction ?? 'forward';
      let searchQuery: { since?: Date; uid?: string; before?: Date };
      let uids: number[];
      
      if (state && state.uidvalidity === uidvalidity && state.last_uid > 0 && direction === 'forward') {
        // Forward sync (refresh): use UID range search for new messages
        // UID range 'N:*' means "UIDs >= N", so we use last_uid + 1 to get UIDs > last_uid
        searchQuery = { uid: `${state.last_uid + 1}:*` };
        const searchResult = await client.search(searchQuery, { uid: true });
        uids = Array.isArray(searchResult) ? searchResult : [];
        fileLogger.info("Forward sync (new messages)", { folder: mailbox, newUids: uids.length, lastUid: state.last_uid });
      } else {
        // Backward sync (continue syncing) or initial sync: use date-based search
        // For backward sync, resume from the oldest already-synced message to avoid re-checking everything
        let effectiveSinceDate = sinceDate;
        let effectiveSinceDateStr = fromDate;
        
        if (direction === 'backward') {
          // Find the oldest message we've already synced
          const oldestSynced = db.prepare("SELECT MIN(date) as oldest_date FROM messages WHERE folder = ?").get(mailbox) as
            | { oldest_date: string | null }
            | undefined;
          
          if (oldestSynced?.oldest_date) {
            const oldestDate = new Date(oldestSynced.oldest_date);
            const oldestDateStr = oldestSynced.oldest_date.slice(0, 10); // YYYY-MM-DD
            
            if (!isNaN(oldestDate.getTime())) {
              // Compare dates at day level (ignore time)
              const oldestDay = oldestDateStr;
              const requestedDay = fromDate;
              
              if (oldestDay > requestedDay) {
                // We've already synced messages from a day newer than requested
                // Resume from the oldest synced date (same day is OK - allows catching gaps from interrupted syncs)
                effectiveSinceDate = new Date(oldestDateStr + "T00:00:00Z");
                effectiveSinceDateStr = oldestDateStr;
                
                // If we have a last_uid checkpoint, use UID-based filtering to avoid re-fetching messages we already have
                // This is much more efficient than fetching all messages from the day and deduplicating
                if (state && Number(state.uidvalidity) === uidvalidity && Number(state.last_uid) > 0) {
                  // For backward sync, we want messages older than what we've synced
                  // But we still need to search the same day to catch gaps, so we'll filter by UID
                  // Search for messages in the date range, but we'll filter UIDs after getting results
                  searchQuery = { since: effectiveSinceDate };
                  
                  fileLogger.info("Resuming backward sync from oldest synced date with UID filtering", {
                    requestedSince: fromDate,
                    oldestSynced: oldestDateStr,
                    resumingFrom: effectiveSinceDateStr,
                    lastUid: state.last_uid,
                    note: "Will filter UIDs <= last_uid to avoid re-fetching already-synced messages",
                  });
                } else {
                  searchQuery = { since: effectiveSinceDate };
                  
                  fileLogger.info("Resuming backward sync from oldest synced date", {
                    requestedSince: fromDate,
                    oldestSynced: oldestDateStr,
                    resumingFrom: effectiveSinceDateStr,
                    note: "No UID checkpoint - will fetch and deduplicate",
                  });
                }
              } else if (oldestDay === requestedDay) {
                // Same day - use UID filtering if available to avoid re-fetching everything
                if (state && Number(state.uidvalidity) === uidvalidity && Number(state.last_uid) > 0) {
                  searchQuery = { since: effectiveSinceDate };
                } else {
                  searchQuery = { since: effectiveSinceDate };
                }
              } else {
                // Oldest synced is before requested date - use requested date
                searchQuery = { since: effectiveSinceDate };
                fileLogger.info("Syncing from requested date", {
                  requestedSince: fromDate,
                  oldestSynced: oldestDateStr,
                });
              }
            } else {
              searchQuery = { since: effectiveSinceDate };
            }
          } else {
            // No messages synced yet, use normal search
            searchQuery = { since: effectiveSinceDate };
          }
        } else {
          searchQuery = { since: effectiveSinceDate };
        }
        const searchResult = await client.search(searchQuery, { uid: true });
        uids = Array.isArray(searchResult) ? searchResult : [];
        if (direction === 'backward') {
          fileLogger.info("Backward sync (filling gaps)", {
            folder: mailbox,
            count: uids.length,
            since: effectiveSinceDateStr,
            requestedSince: fromDate,
          });
        } else {
          fileLogger.info("Messages to sync", { folder: mailbox, count: uids.length, since: fromDate });
        }
      }
      
      // For backward sync: if we're searching the same day as oldest synced and all UIDs are <= last_uid,
      // we've already synced everything from that day. Skip to searching before that date.
      if (direction === 'backward' && state && state.uidvalidity === uidvalidity && state.last_uid > 0) {
        const allUidsAreSynced = uids.length > 0 && uids.every((uid) => uid <= state.last_uid);
        
        if (allUidsAreSynced) {
          // All UIDs from this search are already synced - we've completed this day
          // Search for messages before the oldest synced date instead
          const oldestSynced = db.prepare("SELECT MIN(date) as oldest_date FROM messages WHERE folder = ?").get(mailbox) as
            | { oldest_date: string | null }
            | undefined;
          
          if (oldestSynced?.oldest_date) {
            const oldestDate = new Date(oldestSynced.oldest_date);
            const dayBeforeOldest = new Date(oldestDate);
            dayBeforeOldest.setDate(dayBeforeOldest.getDate() - 1);
            
            // Only search before if it's still within the requested range
            if (dayBeforeOldest >= sinceDate) {
              fileLogger.info("All messages from this day already synced - searching before oldest synced date", {
                oldestSynced: oldestSynced.oldest_date.slice(0, 10),
                searchingBefore: dayBeforeOldest.toISOString().slice(0, 10),
                skippedUids: uids.length,
              });
              
              // Re-search with before constraint
              searchQuery = {
                since: sinceDate,
                before: dayBeforeOldest,
              } as { since: Date; before: Date };
              const searchResult = await client.search(searchQuery, { uid: true });
              uids = Array.isArray(searchResult) ? searchResult : [];
            } else {
              // Day before oldest is before requested date - nothing more to sync
              fileLogger.info("All messages from requested date range already synced", {
                oldestSynced: oldestSynced.oldest_date.slice(0, 10),
                requestedSince: fromDate,
              });
              uids = [];
            }
          }
        } else {
          // Some UIDs might be new - filter to only those we haven't synced yet
          const beforeFilter = uids.length;
          uids = uids.filter((uid) => uid > state.last_uid);
          const filtered = beforeFilter - uids.length;
          
          if (filtered > 0) {
            fileLogger.info("Filtered UIDs using last_uid checkpoint", {
              beforeFilter,
              afterFilter: uids.length,
              filtered,
            });
          }
        }
      }
      
      // Sort UIDs: always newest first (descending) so most recent messages arrive first
      // This applies to both forward and backward sync for better UX
      uids.sort((a, b) => b - a); // Highest UID = most recent

      if (uids.length === 0) {
        db.exec("UPDATE sync_summary SET last_sync_at = datetime('now') WHERE id = 1");
        releaseLock(db, "sync_summary");
        const durationMs = Date.now() - startTime;
        const result: SyncResult = {
          synced: 0,
          messagesFetched: 0,
          bytesDownloaded: 0,
          durationMs,
          bandwidthBytesPerSec: 0,
          messagesPerMinute: 0,
          logPath: fileLogger.logPath,
        };
        logSyncMetrics(fileLogger, result);
        fileLogger.close();
        return result;
      }

      let synced = 0;
      let messagesFetched = 0;
      let bytesDownloaded = 0;
      let earliestDate: string | null = null;
      let latestDate: string | null = null;

      // Track the highest UID we've successfully checkpointed so far.
      // Starts from the last known checkpoint (may be 0 on first run).
      let checkpointUid = state && state.uidvalidity === uidvalidity ? (state.last_uid ?? 0) : 0;

      for (let i = 0; i < uids.length; i += BATCH_SIZE) {
        const batch = uids.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(uids.length / BATCH_SIZE);
        fileLogger.info("fetchAll start", {
          batch: `${batchNum}/${totalBatches}`,
          uids: batch.length,
          uidRange: `${batch[0]}..${batch[batch.length - 1]}`,
        });
        const fetchStart = Date.now();
        let fetchTimeoutId: ReturnType<typeof setTimeout> | undefined;
        const messages = await Promise.race([
          client.fetchAll(batch, { envelope: true, source: true, labels: true }, { uid: true }),
          new Promise<never>((_, reject) => {
            fetchTimeoutId = setTimeout(() => {
              reject(new Error(`fetchAll timed out after 30s (batch ${batchNum}/${totalBatches}, ${batch.length} UIDs)`));
            }, 30_000);
          }),
        ]);
        clearTimeout(fetchTimeoutId);
        const fetchDuration = Date.now() - fetchStart;
        fileLogger.info("fetchAll done", {
          batch: `${batchNum}/${totalBatches}`,
          messages: messages.length,
          elapsedMs: fetchDuration,
        });

        let batchDuplicates = 0;
        let batchNew = 0;
        
        for (const msg of messages) {
          const raw = msg.source;
          if (!raw || !Buffer.isBuffer(raw)) continue;

          messagesFetched++;
          bytesDownloaded += Buffer.byteLength(raw);

          const labelSet = msg.labels != null ? (msg.labels instanceof Set ? msg.labels : new Set(msg.labels as string[])) : new Set<string>();
          const labelsArr = [...labelSet];
          const hasExcluded = excludeLabels.length > 0 && labelsArr.some((l) => excludeLabels.includes(String(l).toLowerCase()));
          if (hasExcluded) {
            continue; // Trash, Spam, etc. — skip storing (still counted in messagesFetched/bytesDownloaded)
          }

          const uid = msg.uid;
          let parsed;
          try {
            // Hard 5s timeout: a stuck parser never blocks the full sync.
            parsed = await Promise.race([
              parseRawMessage(Buffer.from(raw)),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("parse timeout")), 5_000)
              ),
            ]);
          } catch (err) {
            fileLogger.warn("Parse failed, skipping message", { uid, bytes: Buffer.byteLength(raw), error: String(err) });
            continue;
          }

          const duplicateCheckStart = Date.now();
          const existing = db.prepare("SELECT 1 FROM messages WHERE message_id = ?").get(parsed.messageId);
          const duplicateCheckDuration = Date.now() - duplicateCheckStart;
          
          if (existing) {
            batchDuplicates++;
            fileLogger.debug("Skipping duplicate", {
              uid,
              messageId: parsed.messageId,
              date: parsed.date,
              checkDurationMs: duplicateCheckDuration,
            });
            continue; // Already in DB; skip write and insert (saves disk I/O and avoids overwriting)
          }
          
          batchNew++;
          
          synced++; // Increment before logging so order is accurate

          const filename = safeFilename(uid, parsed.messageId);
          const relPath = join("cur", filename);
          const absPath = join(config.maildirPath, relPath);
          writeFileSync(absPath, raw, "binary");

          const threadId = parsed.messageId;
          const labelsJson = JSON.stringify(labelsArr);
          db.prepare(
            `INSERT INTO messages (
              message_id, thread_id, folder, uid, labels, from_address, from_name,
              to_addresses, cc_addresses, subject, date, body_text, raw_path, embedding_state
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
          ).run(
            parsed.messageId,
            threadId,
            mailbox,
            uid,
            labelsJson,
            parsed.fromAddress,
            parsed.fromName,
            JSON.stringify(parsed.toAddresses),
            JSON.stringify(parsed.ccAddresses),
            parsed.subject,
            parsed.date,
            parsed.bodyText,
            relPath,
          );

          db.prepare(
            `INSERT OR REPLACE INTO threads (thread_id, subject, participant_count, message_count, last_message_at)
             VALUES (?, ?, 1, 1, ?)`
          ).run(threadId, parsed.subject, parsed.date);

          // Process attachments
          if (parsed.attachments.length > 0) {
            const attachmentsDir = join(config.maildirPath, "attachments", parsed.messageId);
            mkdirSync(attachmentsDir, { recursive: true });

            for (const att of parsed.attachments) {
              const uniqueFilename = ensureUniqueFilename(attachmentsDir, att.filename);
              const attachmentPath = join(attachmentsDir, uniqueFilename);
              writeFileSync(attachmentPath, att.content, "binary");

              const storedPath = join("attachments", parsed.messageId, uniqueFilename);
              db.prepare(
                `INSERT INTO attachments (message_id, filename, mime_type, size, stored_path, extracted_text)
                 VALUES (?, ?, ?, ?, ?, NULL)`
              ).run(parsed.messageId, att.filename, att.mimeType, att.size, storedPath);
            }
          }

          // synced++ moved earlier (before logging)
          if (!earliestDate || parsed.date < earliestDate) earliestDate = parsed.date;
          if (!latestDate || parsed.date > latestDate) latestDate = parsed.date;
        }
        
        // Log progress every 100 messages or at batch boundaries
        if (synced % 100 === 0 && synced > 0) {
          fileLogger.info("Sync progress", {
            synced,
            messagesFetched,
            duplicates: batchDuplicates,
          });
        }

        // Checkpoint after each batch: next run skips these UIDs entirely,
        // even if we crash before the full sync completes.
        // Always update last_uid to the highest UID we've synced, regardless of direction.
        // This ensures we don't re-fetch messages we've already synced.
        const batchMaxUid = Math.max(...batch);
        if (batchMaxUid > checkpointUid) {
          checkpointUid = batchMaxUid;
          db.prepare(
            "INSERT OR REPLACE INTO sync_state (folder, uidvalidity, last_uid) VALUES (?, ?, ?)"
          ).run(mailbox, uidvalidity, checkpointUid);
        }
      }

      db.prepare(
        `UPDATE sync_summary SET
          earliest_synced_date = COALESCE(?, earliest_synced_date),
          latest_synced_date = COALESCE(?, latest_synced_date),
          total_messages = (SELECT COUNT(*) FROM messages),
          last_sync_at = datetime('now')
         WHERE id = 1`
      ).run(earliestDate, latestDate);
      releaseLock(db, "sync_summary");

      const durationMs = Date.now() - startTime;
      const durationSec = durationMs / 1000;
      const result: SyncResult = {
        synced,
        messagesFetched,
        bytesDownloaded,
        durationMs,
        bandwidthBytesPerSec: durationSec > 0 ? bytesDownloaded / durationSec : 0,
        messagesPerMinute: durationSec > 0 ? (messagesFetched / durationSec) * 60 : 0,
        logPath: fileLogger.logPath,
      };
      logSyncMetrics(fileLogger, result);
      fileLogger.close();

      return result;
    } finally {
      lock.release();
    }
  } catch (err) {
    releaseLock(db, "sync_summary");
    fileLogger.error("Sync failed", { error: String(err) });
    fileLogger.close();
    throw err;
  } finally {
    // Force-close the connection. On a stalled/timed-out socket, logout hangs
    // indefinitely, so we close unconditionally and let the OS clean up TCP state.
    client.close();
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  runSync().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
