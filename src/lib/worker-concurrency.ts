/** Default worker count when `ZMAIL_WORKER_CONCURRENCY` is unset (production / CLI). */
export const DEFAULT_ZMAIL_WORKER_CONCURRENCY = 8;

/**
 * Max worker threads for CPU-parallel zmail work (maildir parse during rebuild today; same knob for future `worker_threads` pools).
 *
 * **Default:** {@link DEFAULT_ZMAIL_WORKER_CONCURRENCY} when unset. Each worker is a full V8 isolate (memory scales with count); tune down on small machines via `ZMAIL_WORKER_CONCURRENCY`.
 *
 * Override with `ZMAIL_WORKER_CONCURRENCY` (non-negative integer). `0` is treated as “no extra workers” and callers clamp to at least 1 logical slot (main-thread execution).
 *
 * Legacy: `ZMAIL_REBUILD_PARSE_CONCURRENCY` is still read if `ZMAIL_WORKER_CONCURRENCY` is unset.
 */
export function getZmailWorkerConcurrency(): number {
  const raw = process.env.ZMAIL_WORKER_CONCURRENCY ?? process.env.ZMAIL_REBUILD_PARSE_CONCURRENCY;
  if (raw !== undefined && raw !== "") {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) {
      return n;
    }
  }
  if (process.env.VITEST) {
    return 1;
  }
  return DEFAULT_ZMAIL_WORKER_CONCURRENCY;
}
