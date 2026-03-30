/** Minimum time to wait for IMAP fetchAll (large batches need more than a fixed 30s). */
export const FETCH_ALL_TIMEOUT_MIN_MS = 60_000;
/** Extra slack per UID (body fetch can be slow on All Mail). */
export const FETCH_ALL_TIMEOUT_PER_UID_MS = 300;
export const FETCH_ALL_TIMEOUT_MAX_MS = 300_000;

/**
 * Extra attempts after the first (e.g. 1 => two tries total: initial + one retry with longer limit).
 */
export const FETCH_ALL_TIMEOUT_EXTRA_ATTEMPTS = 1;

/**
 * Compute per-batch fetchAll wall-clock timeout. Scales with batch size, capped.
 */
export function computeFetchAllTimeoutMs(batchLength: number): number {
  const scaled = 30_000 + batchLength * FETCH_ALL_TIMEOUT_PER_UID_MS;
  return Math.min(FETCH_ALL_TIMEOUT_MAX_MS, Math.max(FETCH_ALL_TIMEOUT_MIN_MS, scaled));
}

export function timeoutMsForFetchAllAttempt(batchLength: number, attempt: number): number {
  const base = computeFetchAllTimeoutMs(batchLength);
  if (attempt <= 1) return base;
  return Math.min(FETCH_ALL_TIMEOUT_MAX_MS, Math.floor(base * 1.5));
}

export function isFetchAllTimeoutMessage(message: string): boolean {
  return message.includes("fetchAll timed out");
}
