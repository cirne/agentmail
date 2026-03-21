import type { FetchMessageObject, ImapFlow } from "imapflow";
import type { FileLogger } from "~/lib/logger";
import {
  FETCH_ALL_TIMEOUT_EXTRA_ATTEMPTS,
  isFetchAllTimeoutMessage,
  timeoutMsForFetchAllAttempt,
} from "./fetch-all-timeout";

/**
 * fetchAll with a batch-scaled timeout and limited retries (Gmail All Mail can exceed a flat 30s).
 */
export async function fetchAllWithTimeoutAndRetries(
  client: ImapFlow,
  batch: number[],
  batchNum: number,
  totalBatches: number,
  fileLogger: FileLogger
): Promise<FetchMessageObject[]> {
  const maxAttempts = 1 + FETCH_ALL_TIMEOUT_EXTRA_ATTEMPTS;
  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const timeoutMs = timeoutMsForFetchAllAttempt(batch.length, attempt);
    let fetchTimeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const messages = await Promise.race([
        client.fetchAll(batch, { envelope: true, source: true, labels: true }, { uid: true }),
        new Promise<never>((_, reject) => {
          fetchTimeoutId = setTimeout(() => {
            reject(
              new Error(
                `fetchAll timed out after ${timeoutMs}ms (attempt ${attempt}/${maxAttempts}, batch ${batchNum}/${totalBatches}, ${batch.length} UIDs)`
              )
            );
          }, timeoutMs);
        }),
      ]);
      if (fetchTimeoutId !== undefined) clearTimeout(fetchTimeoutId);
      if (attempt > 1) {
        fileLogger.info("fetchAll completed after retry", {
          batch: `${batchNum}/${totalBatches}`,
          attempt,
        });
      }
      return messages;
    } catch (e) {
      if (fetchTimeoutId !== undefined) clearTimeout(fetchTimeoutId);
      lastErr = e instanceof Error ? e : new Error(String(e));
      const timedOut = isFetchAllTimeoutMessage(lastErr.message);
      if (!timedOut || attempt >= maxAttempts) {
        if (timedOut && attempt >= maxAttempts) {
          fileLogger.error("fetchAll timed out on all attempts; aborting sync run", {
            batch: `${batchNum}/${totalBatches}`,
            attempts: maxAttempts,
            lastTimeoutMs: timeoutMs,
            action: "abort_sync",
            releasedMailboxLock: true,
            releasedSyncSummaryLock: "after_error",
            imapConnection: "closed_in_finally",
            checkpointNote:
              "This batch was not checkpointed; earlier batches in this run remain committed in sync_state.last_uid",
            resume: "Re-run the same sync command to continue (e.g. zmail sync --foreground).",
          });
        }
        throw lastErr;
      }
      const nextTimeout = timeoutMsForFetchAllAttempt(batch.length, attempt + 1);
      fileLogger.warn("fetchAll timed out; retrying same batch with longer limit", {
        batch: `${batchNum}/${totalBatches}`,
        attempt,
        nextAttempt: attempt + 1,
        failedAfterMs: timeoutMs,
        nextTimeoutMs: nextTimeout,
      });
    }
  }
  throw lastErr ?? new Error("fetchAll: unexpected end of retry loop");
}
