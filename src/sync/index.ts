import { mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { ImapFlow } from "imapflow";
import { config, requireImapConfig } from "~/lib/config";
import { getDb } from "~/db";
import { acquireLock, releaseLock } from "~/lib/process-lock";
import { parseRawMessage } from "./parse-message";
import { parseSinceToDate } from "./parse-since";
import { createFileLogger, SYNC_LOG_PATH, setLogger, type FileLogger } from "~/lib/logger";
import { withTimer } from "~/lib/timer";
import { persistMessage, persistAttachmentsFromParsed } from "~/db/message-persistence";
import { writeMessageMeta } from "~/lib/message-meta";

/** Mailbox to sync: All Mail for Gmail (per ADR-011), INBOX for others. */
function getSyncMailbox(host: string): string {
  return host.toLowerCase().includes("gmail") ? "[Gmail]/All Mail" : "INBOX";
}

export interface SyncOptions {
  /** Relative since spec (e.g. 7d, 5w, 3m, 2y). Overrides sync.defaultSince from config.json when set. */
  since?: string;
  /** Sync direction: 'forward' (newest first, for updates) or 'backward' (oldest first, for backfill). Default: 'forward' */
  direction?: 'forward' | 'backward';
  /** When true, skip STATUS early exit and always run SEARCH + fetch (for refresh when user knows new mail arrived). */
  force?: boolean;
}

export interface SyncResult {
  synced: number;
  messagesFetched: number;
  bytesDownloaded: number;
  durationMs: number;
  bandwidthBytesPerSec: number;
  messagesPerMinute: number;
  logPath: string;
  /** True when we returned without fetching because STATUS reported no new messages. */
  earlyExit?: boolean;
  /** Message IDs of newly synced messages (capped at 50) for preview output. */
  newMessageIds?: string[];
}

// Batch sizes: smaller for forward sync (incremental), larger for backward sync (backfill)
const BATCH_SIZE_FORWARD = 50;  // Small incremental updates
const BATCH_SIZE_BACKWARD = 300; // Large backfill operations

function ensureMaildir() {
  const base = config.maildirPath;
  mkdirSync(join(base, "cur"), { recursive: true });
  mkdirSync(join(base, "new"), { recursive: true });
  mkdirSync(join(base, "tmp"), { recursive: true });
  mkdirSync(join(base, "attachments"), { recursive: true });
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
  
  // Create file logger for sync (fixed log path, append mode)
  // Extract just the filename from the fixed path for createFileLogger
  const syncLogFilename = "sync";
  const fileLogger = createFileLogger(syncLogFilename);
  
  // Replace global logger with file logger for this sync operation
  const restoreLogger = setLogger(fileLogger);
  
  try {
    // Write run separator as the VERY FIRST thing (before any checks, config, etc.)
    // This ensures even early exits (lock contention, config errors) are clearly delineated
    fileLogger.writeSeparator(process.pid);
  
    // Phase timing instrumentation
    const phaseTimings: Record<string, number> = {};
    const phaseMs = (label: string): void => {
      const elapsed = Date.now() - startTime;
      phaseTimings[label] = elapsed;
      fileLogger.info("Phase", { phase: label, elapsedMs: elapsed });
    };
    
    // Timer helper configured with sync logger
    const timer = <T>(
      label: string,
      fn: () => Promise<T>,
      options?: { logSlow?: number; logLevel?: 'debug' | 'info' | 'warn' }
    ) => withTimer(label, fn, { logger: fileLogger, ...options });
    
    phaseMs("runSync_entry");
    
    const imap = requireImapConfig();
    if (!imap.user || !imap.password) {
      fileLogger.info("Config error: imap.user and imap.password required");
      fileLogger.close();
      restoreLogger();
      throw new Error("imap.user and imap.password are required for sync. Run 'zmail setup' or set in ~/.zmail/config.json and .env");
    }

    const sinceSpec = options?.since ?? config.sync.defaultSince;
    const fromDate = parseSinceToDate(sinceSpec);
    fileLogger.info("Sync starting", { user: imap.user, fromDate });

    // Pre-check: if sync is already running, skip connect entirely
    const db = await getDb();

    // Store target start date and capture current earliest date for progress tracking
    const currentEarliest = (await (await db.prepare("SELECT earliest_synced_date FROM sync_summary WHERE id = 1")).get()) as
      | { earliest_synced_date: string | null }
      | undefined;
    await (
      await db.prepare("UPDATE sync_summary SET target_start_date = ?, sync_start_earliest_date = ? WHERE id = 1")
    ).run(fromDate, currentEarliest?.earliest_synced_date ?? null);
    const syncRunningCheck = (await (await db.prepare("SELECT is_running, owner_pid FROM sync_summary WHERE id = 1")).get()) as
      | { is_running: number; owner_pid: number | null }
      | undefined;
    const isRunning = syncRunningCheck?.is_running === 1;
    
    if (isRunning) {
      fileLogger.info("Sync already running, exiting", { ownerPid: syncRunningCheck.owner_pid });
      const durationMs = Date.now() - startTime;
      phaseMs("runSync_exit_early");
      fileLogger.close();
      restoreLogger();
      return {
        synced: 0,
        messagesFetched: 0,
        bytesDownloaded: 0,
        durationMs,
        bandwidthBytesPerSec: 0,
        messagesPerMinute: 0,
        logPath: SYNC_LOG_PATH,
      };
    }

    ensureMaildir();

    const sinceDate = new Date(fromDate + "T00:00:00Z");
    if (isNaN(sinceDate.getTime())) {
      throw new Error(`Invalid from date: ${fromDate}. Use --since 7d, 5w, 3m, 2y or set sync.defaultSince in config.json.`);
    }

    // Parallelize connect with lock acquisition
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
    
    phaseMs("connect_called");
    const connectStartMs = Date.now() - startTime;
    
    // Start connect in parallel with lock acquisition
    const connectPromise = client.connect();
    const lockStartMs = Date.now() - startTime;
    
    // Acquire lock with PID-based ownership
    const lockResult = await acquireLock(db, "sync_summary", process.pid);
    const lockDoneMs = Date.now() - startTime;
    phaseMs("lock_acquired");
    
    if (!lockResult.acquired) {
      fileLogger.info("Sync already running, exiting");
      const durationMs = Date.now() - startTime;
      phaseMs("runSync_exit_early");
      fileLogger.close();
      restoreLogger();
      return {
        synced: 0,
        messagesFetched: 0,
        bytesDownloaded: 0,
        durationMs,
        bandwidthBytesPerSec: 0,
        messagesPerMinute: 0,
        logPath: SYNC_LOG_PATH,
      };
    }
    if (lockResult.takenOver) {
      // Partial work is safe: sync_state.last_uid is correct,
      // and message dedup prevents re-inserts
      fileLogger.info("Recovered from crashed sync, resuming from last checkpoint");
    }
    
    // Wait for connect to complete
    try {
    await connectPromise;
    const connectDoneMs = Date.now() - startTime;
    phaseMs("connect_resolved");
    fileLogger.info("IMAP connected", { 
      host: imap.host,
      connectStartMs,
      connectDoneMs,
      lockStartMs,
      lockDoneMs,
      overlapMs: Math.max(0, connectDoneMs - lockDoneMs),
    });
  } catch (err) {
    // Explicitly catch and log connection/auth errors before they reach outer catch
    fileLogger.error("IMAP connection failed", { 
      host: imap.host,
      port: imap.port,
      user: imap.user,
      error: String(err),
      errorMessage: err instanceof Error ? err.message : String(err),
    });
      await releaseLock(db, "sync_summary", process.pid);
      fileLogger.close();
      restoreLogger();
      throw err; // Re-throw so outer catch handles it
    }
    
    // Check TLS session resumption (Step 7)
    try {
    const socket = (client as any).socket;
    if (socket && typeof socket.getSession === 'function') {
      const session = socket.getSession();
      fileLogger.info("TLS session", { sessionReused: session != null });
    } else if (socket && typeof socket.isSessionReused === 'function') {
      fileLogger.info("TLS session", { sessionReused: socket.isSessionReused() });
    }
    } catch (err) {
      // Ignore errors accessing internal socket
    }

    try {
      const mailbox = config.sync.mailbox || getSyncMailbox(imap.host);
      const excludeLabels = config.sync.excludeLabels; // lowercase
    
    // Step 2: STATUS check before SELECT
    // Read sync_state first to check if we can early-exit
    const stateRow = (await (await db.prepare("SELECT uidvalidity, last_uid FROM sync_state WHERE folder = ?")).get(
      mailbox
    )) as { uidvalidity: number | bigint; last_uid: number | bigint } | undefined;
    const state = stateRow ? {
      uidvalidity: Number(stateRow.uidvalidity),
      last_uid: Number(stateRow.last_uid),
    } : undefined;
    
      // Call STATUS before acquiring mailbox lock
      let statusResult: Awaited<ReturnType<typeof client.status>> | null = null;
      try {
      const { result, durationMs: statusRoundTripMs } = await timer(
        "STATUS",
        () => client.status(mailbox, { messages: true, uidNext: true, uidValidity: true })
      );
      statusResult = result;
      phaseMs("status_resolved");
      
      if (!statusResult) {
        fileLogger.warn("STATUS returned null, skipping early exit check");
      } else {
        // Convert BigInt to Number for logging (JSON.stringify can't serialize BigInt)
        const uidNextNum = statusResult.uidNext ? Number(statusResult.uidNext) : undefined;
        const uidValidityNum = statusResult.uidValidity ? Number(statusResult.uidValidity) : undefined;
        
        fileLogger.info("STATUS response", {
          statusRoundTripMs,
          uidNext: uidNextNum,
          uidValidity: uidValidityNum,
          lastKnownUid: state?.last_uid ?? 0,
          delta: uidNextNum ? uidNextNum - (state?.last_uid ?? 0) - 1 : undefined,
        });
        
        // Early exit if no new messages (only for forward sync - backward sync needs to search for older messages)
        const direction = options?.direction ?? 'forward';
        // Convert BigInt to Number for comparison
        const statusUidNextNum = statusResult.uidNext ? Number(statusResult.uidNext) : undefined;
        const statusUidValidityNum = statusResult.uidValidity ? Number(statusResult.uidValidity) : undefined;
        
        fileLogger.info("Early exit check", {
          direction,
          hasState: !!state,
          statusUidNext: statusUidNextNum,
          statusUidValidity: statusUidValidityNum,
          stateUidValidity: state?.uidvalidity,
          stateLastUid: state?.last_uid,
          uidValidityMatch: state && statusUidValidityNum === state.uidvalidity,
          shouldEarlyExit: direction === 'forward' && state && statusUidNextNum && statusUidValidityNum === state.uidvalidity && statusUidNextNum - 1 <= state.last_uid,
        });
        
        // Only early exit for forward sync (backward sync needs to search for older messages).
        // Skip early exit when force is set so user can force a full fetch when they know new mail arrived.
        if (direction === 'forward' && !options?.force && state && statusUidNextNum && statusUidValidityNum === state.uidvalidity) {
          if (statusUidNextNum - 1 <= state.last_uid) {
            await db.exec("UPDATE sync_summary SET last_sync_at = datetime('now') WHERE id = 1");
            await releaseLock(db, "sync_summary", process.pid);
            const durationMs = Date.now() - startTime;
            phaseMs("runSync_exit_early");
            fileLogger.info("Early exit: no new messages", { elapsedMs: durationMs });
          const result: SyncResult = {
            synced: 0,
            messagesFetched: 0,
            bytesDownloaded: 0,
            durationMs,
            bandwidthBytesPerSec: 0,
            messagesPerMinute: 0,
            logPath: SYNC_LOG_PATH,
            earlyExit: true,
            newMessageIds: [],
          };
          logSyncMetrics(fileLogger, result);
          // Emit phase summary
          fileLogger.info("Phase summary", {
            phase: "summary",
            ...phaseTimings,
            totalMs: durationMs,
          });
          fileLogger.close();
          restoreLogger();
          return result;
          }
        }
      }
      } catch (err) {
        // STATUS may not be supported or may fail - log and continue
        fileLogger.warn("STATUS command failed, continuing with EXAMINE", { error: String(err) });
      }
      
      // Use EXAMINE (read-only) instead of SELECT since we never modify messages
      // EXAMINE is faster for Gmail's All Mail folder as it doesn't need to materialize write locks
      const { result: lock, durationMs: examineMs } = await timer(
        "EXAMINE",
        () => client.getMailboxLock(mailbox, { readOnly: true })
      );
      phaseMs("examine_resolved");
      fileLogger.info("Mailbox opened (EXAMINE)", { examineMs });
      try {
        const mailboxObj = client.mailbox;
      const uidvalidity = mailboxObj && typeof mailboxObj === "object" ? Number(mailboxObj.uidValidity ?? 0) : 0;
      
      // Incremental sync (ADR-003): use UID range search when we have a checkpoint
      // This avoids fetching all UIDs since a date and filtering client-side
      // Note: state was already read above for STATUS check, reuse it
      
      const direction = options?.direction ?? 'forward';
      let searchQuery: { since?: Date; uid?: string; before?: Date };
      let uids: number[];
      /** True when user requested a wider range than we have (backfill older UIDs, not just uid > last_uid). */
      let isExpandingRangeBackward = false;

      if (state && state.uidvalidity === uidvalidity && state.last_uid > 0 && direction === 'forward') {
        // Forward sync (refresh): use UID range search for new messages
        // UID range 'N:*' means "UIDs >= N", so we use last_uid + 1 to get UIDs > last_uid
        searchQuery = { uid: `${state.last_uid + 1}:*` };
        const { result: searchResult } = await timer(
          "search",
          () => client.search(searchQuery, { uid: true })
        );
        phaseMs("search_resolved");
        uids = Array.isArray(searchResult) ? searchResult : [];
        fileLogger.info("Forward sync (new messages)", { folder: mailbox, newUids: uids.length, lastUid: state.last_uid });
      } else {
        // Backward sync (continue syncing) or initial sync: use date-based search
        // For backward sync, resume from the oldest already-synced message to avoid re-checking everything
        let effectiveSinceDate = sinceDate;
        let effectiveSinceDateStr = fromDate;

        if (direction === 'backward') {
          // Find the oldest message we've already synced
          const oldestSynced = (await (
            await db.prepare("SELECT MIN(date) as oldest_date FROM messages WHERE folder = ?")
          ).get(mailbox)) as { oldest_date: string | null } | undefined;
          
          if (oldestSynced?.oldest_date) {
            const oldestDate = new Date(oldestSynced.oldest_date);
            const oldestDateStr = oldestSynced.oldest_date.slice(0, 10); // YYYY-MM-DD
            
            if (!isNaN(oldestDate.getTime())) {
              // Compare dates at day level (ignore time)
              const oldestDay = oldestDateStr;
              const requestedDay = fromDate;
              
              if (oldestDay > requestedDay) {
                // User is requesting a wider range than what's already synced (oldestDay > requestedDay)
                // Use the requested date as the search boundary to fetch the unfetched date range.
                // Backfill messages have lower UIDs than what we have; we filter by "not already in DB" below.
                isExpandingRangeBackward = true;
                effectiveSinceDate = new Date(fromDate + "T00:00:00Z");
                effectiveSinceDateStr = fromDate;
                
                searchQuery = { since: effectiveSinceDate };
                fileLogger.info("Expanding sync range backward", {
                  requestedSince: fromDate,
                  oldestSynced: oldestDateStr,
                  searchingFrom: effectiveSinceDateStr,
                  note: "Will fetch UIDs not already in DB (backfill + new)",
                });
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
        const { result: searchResult } = await timer(
          "search",
          () => client.search(searchQuery, { uid: true })
        );
        phaseMs("search_resolved");
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
      
      // For backward sync: filter to UIDs we need to fetch (avoid re-fetching what we have).
      if (direction === 'backward' && state && state.uidvalidity === uidvalidity && state.last_uid > 0) {
        if (isExpandingRangeBackward) {
          // Expanding range: search already includes requested date. We need backfill (low UIDs) and possibly new (uid > last_uid).
          // Filter to UIDs not already in DB (last_uid filter would drop all backfill).
          const existingUids = (await (
            await db.prepare("SELECT uid FROM messages WHERE folder = ?")
          ).all(mailbox)) as { uid: number }[];
          const existingSet = new Set(existingUids.map((r) => r.uid));
          const beforeFilter = uids.length;
          uids = uids.filter((uid) => !existingSet.has(uid));
          const filtered = beforeFilter - uids.length;
          if (filtered > 0) {
            fileLogger.info("Filtered UIDs for range expansion (exclude already in DB)", {
              beforeFilter,
              afterFilter: uids.length,
              filtered,
            });
          }
        } else {
          const allUidsAreSynced = uids.length > 0 && uids.every((uid) => uid <= state.last_uid);
          if (allUidsAreSynced) {
            // All UIDs from this search are already synced - we've completed this day
            // Search for messages before the oldest synced date instead
            const oldestSynced = (await (
              await db.prepare("SELECT MIN(date) as oldest_date FROM messages WHERE folder = ?")
            ).get(mailbox)) as { oldest_date: string | null } | undefined;
            
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
                const { result: searchResult } = await timer(
                  "search",
                  () => client.search(searchQuery, { uid: true })
                );
                phaseMs("search_resolved");
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
            // Resume (not expanding): only fetch UIDs we haven't synced yet (uid > last_uid)
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
      }
      
      // Sort UIDs: always newest first (descending) so most recent messages arrive first
      // This applies to both forward and backward sync for better UX
      uids.sort((a, b) => b - a); // Highest UID = most recent

      if (uids.length === 0) {
        await db.exec("UPDATE sync_summary SET last_sync_at = datetime('now') WHERE id = 1");
        await releaseLock(db, "sync_summary", process.pid);
        const durationMs = Date.now() - startTime;
        phaseMs("runSync_exit");
        const result: SyncResult = {
          synced: 0,
          messagesFetched: 0,
          bytesDownloaded: 0,
          durationMs,
          bandwidthBytesPerSec: 0,
          messagesPerMinute: 0,
          logPath: SYNC_LOG_PATH,
        };
        logSyncMetrics(fileLogger, result);
        // Emit phase summary
        fileLogger.info("Phase summary", {
          phase: "summary",
          ...phaseTimings,
          totalMs: durationMs,
        });
        fileLogger.close();
        restoreLogger();
        return result;
      }

      let synced = 0;
      let messagesFetched = 0;
      let bytesDownloaded = 0;
      let earliestDate: string | null = null;
      let latestDate: string | null = null;
      const newMessageIds: string[] = [];
      const NEW_MESSAGE_IDS_CAP = 50;

      // Track the highest UID we've successfully checkpointed so far.
      // Starts from the last known checkpoint (may be 0 on first run).
      let checkpointUid = state && state.uidvalidity === uidvalidity ? (state.last_uid ?? 0) : 0;

      // Use larger batch size for backward sync (backfill) to reduce IMAP round-trips
      const batchSize = direction === 'backward' ? BATCH_SIZE_BACKWARD : BATCH_SIZE_FORWARD;
      // Use fetchAll() for backward sync - guarantees no gaps/duplicates with explicit UID arrays
      // Pipelining (fetch() async generator) had issues with sequence set parsing causing duplicate fetches
      const usePipelining = false; // Disabled: fetchAll() is simpler and more reliable
      
      // Helper function to process a single message (declared before loop so it can be used in both branches)
      const processMessage = async (msg: any): Promise<{ isDuplicate: boolean; isNew: boolean; messageId?: string }> => {
        const raw = msg.source;
        if (!raw || !Buffer.isBuffer(raw)) {
          return { isDuplicate: false, isNew: false, messageId: undefined };
        }

        messagesFetched++;
        bytesDownloaded += Buffer.byteLength(raw);

        const labelSet = msg.labels != null ? (msg.labels instanceof Set ? msg.labels : new Set(msg.labels as string[])) : new Set<string>();
        const labelsArr = [...labelSet];
        const hasExcluded = excludeLabels.length > 0 && labelsArr.some((l) => excludeLabels.includes(String(l).toLowerCase()));
        if (hasExcluded) {
          return { isDuplicate: false, isNew: false, messageId: undefined }; // Trash, Spam, etc. — skip storing (still counted in messagesFetched/bytesDownloaded)
        }

        const uid = msg.uid;
        let parsed;
        try {
          // Hard 5s timeout: a stuck parser never blocks the full sync.
          const { result, durationMs: parseMs } = await timer(
            "parse",
            () => Promise.race([
              parseRawMessage(Buffer.from(raw)),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("parse timeout")), 5_000)
              ),
            ]),
            { logSlow: 500, logLevel: 'debug' }
          );
          parsed = result;
          if (parseMs > 500) {
            fileLogger.debug("Slow parse", { uid, parseMs, bytes: Buffer.byteLength(raw) });
          }
        } catch (err) {
          fileLogger.warn("Parse failed, skipping message", { uid, bytes: Buffer.byteLength(raw), error: String(err) });
          return { isDuplicate: false, isNew: false, messageId: undefined };
        }

        const { result: existing, durationMs: duplicateCheckDuration } = await timer(
          "duplicate_check",
          async () => (await (await db.prepare("SELECT 1 FROM messages WHERE message_id = ?")).get(parsed.messageId))
        );
        
        if (existing) {
          fileLogger.debug("Skipping duplicate", {
            uid,
            messageId: parsed.messageId,
            date: parsed.date,
            checkDurationMs: duplicateCheckDuration,
          });
          return { isDuplicate: true, isNew: false, messageId: undefined }; // Already in DB; skip write and insert (saves disk I/O and avoids overwriting)
        }
        
        synced++; // Increment before logging so order is accurate

        const filename = safeFilename(uid, parsed.messageId);
        const relPath = join("cur", filename);
        const absPath = join(config.maildirPath, relPath);
        const { durationMs: writeMs } = await timer(
          "disk_write",
          async () => {
            writeFileSync(absPath, raw, "binary");
          },
          { logSlow: 100, logLevel: 'debug' }
        );
        if (writeMs > 100) {
          fileLogger.debug("Slow disk write", { uid, writeMs, bytes: Buffer.byteLength(raw) });
        }

        const labelsJson = JSON.stringify(labelsArr);

        // Write sidecar metadata (labels, etc.) alongside EML for rebuild
        if (labelsArr.length > 0) {
          writeMessageMeta(absPath, { labels: labelsArr });
        }
        
        // Persist message and thread using shared helper
        await persistMessage(db, parsed, mailbox, uid, labelsJson, relPath);

        await persistAttachmentsFromParsed(db, parsed.messageId, parsed.attachments);

        // synced++ moved earlier (before logging)
        if (!earliestDate || parsed.date < earliestDate) earliestDate = parsed.date;
        if (!latestDate || parsed.date > latestDate) latestDate = parsed.date;
        
        return { isDuplicate: false, isNew: true, messageId: parsed.messageId };
      };
      
      for (let i = 0; i < uids.length; i += batchSize) {
        const batch = uids.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;
        const totalBatches = Math.ceil(uids.length / batchSize);
        
        let batchDuplicates = 0;
        let batchNew = 0;
        let batchMessagesProcessed = 0;
        
        if (usePipelining) {
          // Pipeline: use async generator to process messages as they arrive
          // This overlaps fetch with parse/insert, improving throughput
          fileLogger.info("fetch start (pipelined)", {
            batch: `${batchNum}/${totalBatches}`,
            uids: batch.length,
            uidRange: `${batch[0]}..${batch[batch.length - 1]}`,
          });
          const batchStart = Date.now();
          // Use comma-separated UID sequence set to fetch only requested UIDs (no gaps)
          // IMAP sequence sets support comma-separated values: "123,456,789"
          const uidSequenceSet = batch.join(',');
          
          // Use fetch() async generator for pipelining with explicit UID list
          // This avoids fetching gaps/unwanted messages that a range would include
          for await (const msg of client.fetch(uidSequenceSet, { envelope: true, source: true, labels: true }, { uid: true })) {
            batchMessagesProcessed++;
            const result = await processMessage(msg);
            if (result.isDuplicate) batchDuplicates++;
            if (result.isNew) {
              batchNew++;
              if (result.messageId && newMessageIds.length < NEW_MESSAGE_IDS_CAP) newMessageIds.push(result.messageId);
            }
          }
          
          const batchDuration = Date.now() - batchStart;
          fileLogger.info("fetch done (pipelined)", {
            batch: `${batchNum}/${totalBatches}`,
            messages: batchMessagesProcessed,
            elapsedMs: batchDuration,
            duplicates: batchDuplicates,
            new: batchNew,
          });
        } else {
          // Non-pipelined: fetch all, then process (better for small forward sync batches)
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

          for (const msg of messages) {
            const result = await processMessage(msg);
            if (result.isDuplicate) batchDuplicates++;
            if (result.isNew) {
              batchNew++;
              if (result.messageId && newMessageIds.length < NEW_MESSAGE_IDS_CAP) newMessageIds.push(result.messageId);
            }
          }
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
          await timer(
            "batch_checkpoint",
            async () => {
              await (
                await db.prepare("INSERT OR REPLACE INTO sync_state (folder, uidvalidity, last_uid) VALUES (?, ?, ?)")
              ).run(mailbox, uidvalidity, checkpointUid);
            }
          );
          phaseMs("batch_checkpoint_committed");
        }
      }
      
      phaseMs("all_batches_complete");

      await (
        await db.prepare(
          `UPDATE sync_summary SET
          earliest_synced_date = COALESCE(?, earliest_synced_date),
          latest_synced_date = COALESCE(?, latest_synced_date),
          total_messages = (SELECT COUNT(*) FROM messages),
          last_sync_at = datetime('now')
         WHERE id = 1`
        )
      ).run(earliestDate, latestDate);
      await releaseLock(db, "sync_summary", process.pid);

      const durationMs = Date.now() - startTime;
      const durationSec = durationMs / 1000;
      const result: SyncResult = {
        synced,
        messagesFetched,
        bytesDownloaded,
        durationMs,
        bandwidthBytesPerSec: durationSec > 0 ? bytesDownloaded / durationSec : 0,
        messagesPerMinute: durationSec > 0 ? (messagesFetched / durationSec) * 60 : 0,
        logPath: SYNC_LOG_PATH,
        newMessageIds: newMessageIds.length > 0 ? newMessageIds.slice(0, NEW_MESSAGE_IDS_CAP) : undefined,
      };
      logSyncMetrics(fileLogger, result);
      
      // Emit phase summary
      phaseMs("runSync_exit");
      fileLogger.info("Phase summary", {
        phase: "summary",
        ...phaseTimings,
        totalMs: durationMs,
      });
      
      // Note: People profiles are built dynamically on-demand (no pre-computed index)
      // This ensures results are always current and improve as more data is indexed.

      fileLogger.close();
      restoreLogger(); // Restore original logger

      return result;
    } finally {
      lock.release();
    }
    } catch (err) {
      await releaseLock(db, "sync_summary", process.pid);
      fileLogger.error("Sync failed", { error: String(err) });
      fileLogger.close();
      restoreLogger(); // Restore original logger even on error
      throw err;
    } finally {
      // Force-close the connection. On a stalled/timed-out socket, logout hangs
      // indefinitely, so we close unconditionally and let the OS clean up TCP state.
      client.close();
    }
  } finally {
    // Ensure logger is always restored even if something goes wrong
    restoreLogger();
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  // Ensure schema is up to date before running sync
  (async () => {
    const { ensureSchemaUpToDate } = await import("~/db");
    await ensureSchemaUpToDate();
    await runSync();
  })().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
