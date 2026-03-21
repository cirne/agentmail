# IMAP Sync Hang — Debug Log

## Status: RESOLVED ✅

---

## Symptom

`bun run src/index.ts sync --since 7d` consistently hangs after logging:

```
INFO  IMAP connected {"host":"imap.gmail.com"}
INFO  Messages to sync {"folder":"[Gmail]/All Mail","count":474,"since":"2026-02-26"}
```

The process sits at 0% CPU indefinitely (no output, no progress, no error). DB stays at 0 or 1 messages. Must be killed manually every time.

---

## Root Cause

**`mailparser`'s `MailParser` class is incompatible with Bun v1.1.38.**

`MailParser` extends Node.js `Writable`. When `parser.end(buffer)` is called, Bun never invokes the internal `_write` callback — so none of the parser events (`headers`, `data`, `end`) ever fire. The returned promise hangs indefinitely.

This was confirmed with per-event instrumentation:

```
parse-message.ts:before-parser-end  → "calling parser.end(raw)"         ✅ fires
parse-message.ts:after-parser-end   → "parser.end(raw) returned sync"    ✅ fires
parse-message.ts:on-headers         →                                     ❌ never fires
parse-message.ts:on-data            →                                     ❌ never fires
parse-message.ts:on-end             →                                     ❌ never fires
```

`simpleParser` (the higher-level API we originally used) has the same problem — it calls `parser.end(source)` internally, so it hangs for the same reason.

---

## Diagnosis Timeline

### What we thought was the problem

The original hang was assumed to be in `fetchAll` (batch network download). We added `Promise.race` with a 15s timeout around `fetchAll`. That "fix" appeared to work — the timeout fired — but the real hang was **after** `fetchAll` completed, inside the message processing loop.

### How we found the real problem

Added per-phase debug logging that revealed the exact hang sequence:

1. `fetchAll` completed fine (50 messages, ~5s) — batch download was never the issue
2. Message processing loop entered for msg #1 (uid 187399, 52KB)
3. `await parseRawMessage(...)` called → **never returned**
4. Event loop was alive (setInterval poll fired every 2s) — not a CPU hang
5. Added per-event logging inside `MailParser` → confirmed zero events fired after `parser.end(raw)`

### Why we didn't catch it sooner

The 15s `Promise.race` timeout around `fetchAll` fired 15s after **batch start**, which was ~8s after `fetchAll` already succeeded. The stale `reject()` call was on an already-resolved `Promise.race`, creating an unhandled rejection that appeared as a spurious timeout warning. This masked the real hang happening inside `parseRawMessage`.

---

## Fix

### 1. Replace `mailparser` with `postal-mime`

`postal-mime` is a stream-free email parser built for non-Node runtimes (Cloudflare Workers, Bun, Deno). It takes an `ArrayBuffer` directly and has no dependency on Node.js stream internals.

```typescript
// src/sync/parse-message.ts
import PostalMime from "postal-mime";

export async function parseRawMessage(raw: Buffer): Promise<ParsedMessage> {
  const email = await PostalMime.parse(raw.buffer as ArrayBuffer);
  // ...
}
```

### 2. Per-message parse timeout (belt-and-suspenders)

Even with `postal-mime`, any parse failure should skip the message, not block the sync:

```typescript
parsed = await Promise.race([
  parseRawMessage(Buffer.from(raw)),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("parse timeout")), 5_000)
  ),
]);
// catch → logger.warn + continue
```

### 3. Fix stale `Promise.race` timer

The original `fetchAll` timeout used an uncancelled `setTimeout`. When `fetchAll` won the race, the timer kept running and fired a stale `reject()` creating an unhandled rejection. Fixed by clearing the timer:

Implemented in `src/sync/fetch-all-with-retries.ts` (calls `fetchAll` via `Promise.race` with `clearTimeout` on success). Per-batch wall time scales with batch size (see `src/sync/fetch-all-timeout.ts`: floor 60s, +300ms per UID, cap 300s) with one retry at 1.5× the base limit when the error message matches `fetchAll timed out`.

---

## Verified Results

Clean run after fix (`--since 1d`, fresh DB):

```
INFO  fetchAll done {"batch":"1/3","messages":50,"elapsedMs":5342}
INFO  fetchAll done {"batch":"2/3","messages":50,"elapsedMs":5229}
INFO  fetchAll done {"batch":"3/3","messages":7,"elapsedMs":516}
INFO  Sync complete {"synced":107,"messagesFetched":107,"bytesDownloaded":36441069,"durationMs":13631}
INFO  Sync metrics {"summary":"107 new, 107 fetched | 34.75 MB down | 2.55 MB/s | 471 msg/min | 13.63s"}
INFO  Indexing complete {"indexed":107,"failed":0,"durationMs":14846}
exit_code: 0
```

No hangs, no spurious WARN, clean exit.

---

## Fixes Already Landed

1. **Per-batch `sync_state` checkpoint** — `last_uid` written after each batch; restarts skip already-fetched UIDs.

2. **Indexer exit condition via `syncDone` promise** — replaced DB polling with an in-process promise signal.

3. **`indexMessages` test suite** — 4 scenario tests covering exit-condition cases.

4. **`postal-mime` replaces `mailparser`** — resolves the Bun/Writable incompatibility. `mailparser` removed from active use.

5. **Per-message 5s parse timeout** — stuck parser skips the message with a WARN, never blocks the sync loop.

6. **`fetchAll` stale timer fixed** — `clearTimeout` after `fetchAll` resolves; per-batch timeout scales with batch size (plus limited retry); see `fetch-all-timeout.ts` / `fetch-all-with-retries.ts`.
