# Sync Implementation & Performance History

This document describes how email sync works today, the optimizations that were tried, and what was learned. See [OPP-010](./opportunities/OPP-010-sync-performance.md) for the original performance analysis and opportunity tracking.

**Related documents:**

- [ARCHITECTURE.md](./ARCHITECTURE.md) — ADR-003, ADR-016, ADR-017, ADR-020 cover sync design principles
- [OPP-010](./opportunities/OPP-010-sync-performance.md) — Performance opportunity tracking and optimization roadmap

---

## Current Implementation (2026-03-06)

### Sync Flow

The current public contract is:

- `zmail refresh` is the default freshness-first operation
- `zmail refresh --since <spec>` is the explicit backfill operation
- both paths avoid re-fetching messages already copied locally
- the default agent expectation is that the most recent unseen mail becomes searchable first

**Incremental refresh (`zmail refresh`):**

1. Connect to IMAP (parallel with lock acquisition)
2. Call `STATUS` to check `UIDNEXT` — early exit if no new messages
3. `EXAMINE` mailbox (read-only, faster than `SELECT`)
4. `SEARCH` with UID range `UID ${last_uid + 1}:*` to find new messages
5. `fetchAll()` with explicit UID array (300 messages per batch for backward, 50 for forward)
6. For each message: parse → check duplicate → write to maildir → insert into SQLite
7. Checkpoint `last_uid` after each batch

This is the path used when the caller wants the newest mail indexed fast. It does not walk backward through older history.

**Backfill refresh (`zmail refresh --since <spec>`):**

1. Connect to IMAP (parallel with lock acquisition)
2. Call `STATUS` (no early exit for backward sync)
3. `EXAMINE` mailbox
4. `SEARCH` with date range, filter UIDs <= `last_uid` client-side
5. `fetchAll()` with explicit UID array (300 messages per batch)
6. Process messages sequentially (parse → insert)
7. Checkpoint `last_uid` after each batch
8. If all messages from a day are synced, search before that date

This is the path used when the caller explicitly asks for more historical coverage than is already available locally.

### Key Design Decisions

**Batch sizes:**

- Forward sync: 50 messages per batch (small incremental updates)
- Backward sync: 300 messages per batch (large backfill operations)

The asymmetry is intentional: incremental update optimizes for latency and recent-mail availability, while backfill optimizes for throughput.

**Why `fetchAll()` instead of streaming:**

- Explicit UID arrays guarantee no gaps/duplicates (100% efficiency)
- Simpler code (no sequence set parsing)
- Eliminated 50% duplicate fetch overhead from streaming approaches

**Why sequential processing:**

- Parallel message processing was tested (8 concurrent operations)
- Result: 12% slower due to SQLite single-writer serialization
- Sequential processing is optimal for current architecture

**Phase instrumentation:**

- Comprehensive timing logs for all phases (connect, STATUS, EXAMINE, search, fetch, parse, insert)
- Phase summary JSON log line at completion for easy analysis
- Enables precise bottleneck identification

---

## Optimization History

### ✅ Completed Optimizations

#### 1. STATUS Fast Path (2026-03-06)

**Problem:** Every incremental update did a full `SELECT` on `[Gmail]/All Mail` (~20s) even when no new messages.

**Solution:** Call `STATUS` before `SELECT`. If `UIDNEXT - 1 <= last_uid`, exit early without opening mailbox.

**Result:** "Nothing new" incremental update: 42s → 8.2s (**5x faster**)

**Implementation:** `src/sync/index.ts` — STATUS check before `getMailboxLock()`

---

#### 2. Parallel Connect (2026-03-06)

**Problem:** TLS handshake (12-18s) ran sequentially before lock acquisition.

**Solution:** Start `client.connect()` in parallel with `getDb()` and lock acquisition.

**Result:** ~6s overlap achieved, hides TLS handshake latency

**Implementation:** `src/sync/index.ts` — `Promise.all([connect(), getDb()])`

---

#### 3. EXAMINE Instead of SELECT (2026-03-06)

**Problem:** `SELECT` on Gmail's `[Gmail]/All Mail` is expensive (~15s) because it materializes full mailbox state.

**Solution:** Use `EXAMINE` (read-only) instead of `SELECT` for sync operations.

**Result:** Mailbox open: 15s → 6.3s (**2.4x faster**)

**Implementation:** `src/sync/index.ts` — `getMailboxLock(mailbox, { readOnly: true })`

---

#### 4. Increased Indexer Concurrency (2026-03-06)

**Problem:** Indexing ran at `INDEXER_CONCURRENCY=2`, finishing 2.5s after sync.

**Solution:** Increase default to 5 concurrent embedding batches.

**Result:** 2x indexing speed improvement

**Implementation:** `src/search/indexing.ts` — `INDEXER_CONCURRENCY` default changed from 2 to 5

---

#### 5. Phase Instrumentation (2026-03-06)

**Problem:** No visibility into which phases were bottlenecks.

**Solution:** Add comprehensive phase-level timing logs with `phaseMs()` helper.

**Result:** Full visibility into bottlenecks, enables data-driven optimization

**Implementation:** `src/sync/index.ts` — phase timing instrumentation, `src/lib/timer.ts` — shared `withTimer()` helper

---

#### 6. Batch Size Increase (2026-03-06)

**Problem:** Backward sync used `BATCH_SIZE=50`, creating many IMAP round-trips.

**Solution:** Use `BATCH_SIZE_BACKWARD=300` for backward sync (vs `BATCH_SIZE_FORWARD=50` for forward).

**Result:** 4-10x fewer IMAP round-trips, better bandwidth utilization

**Implementation:** `src/sync/index.ts` — adaptive batch sizing based on sync direction

---

#### 7. fetchAll() with Explicit UIDs (2026-03-06)

**Problem:** Attempted pipelining with `client.fetch()` using UID ranges or comma-separated sequence sets caused duplicate fetches (50% overhead).

**Attempted solutions:**

1. UID range: `${batch[0]}:${batch[batch.length - 1]}` — fetched ALL messages in range, including gaps
2. Comma-separated UIDs: `batch.join(',')` — still fetched duplicates (possibly IMAP server sequence set length limits)

**Final solution:** Use `fetchAll()` with explicit UID array (`fetchAll(batch, ...)` where `batch` is an array of UIDs).

**Result:**

- ✅ 100% efficiency — 523 messages fetched (exact match, no duplicates)
- ✅ 50% bandwidth savings — 92.07 MB vs 184.15 MB
- ✅ 48% faster — 71.55s vs 137.5s (eliminating duplicate fetches)
- ✅ Simpler code — no sequence set parsing or filtering needed

**Implementation:** `src/sync/index.ts` — `usePipelining = false`, using `fetchAll()` for all syncs

---

### ❌ Attempted Optimizations That Didn't Help

#### Parallel Message Processing (2026-03-06)

**Attempted:** Process 8 messages concurrently after `fetchAll()` returns using `Promise.all()`.

**Expected:** 2-3x speedup from parallel parsing/inserting.

**Result:** 12% slower (80.14s vs 71.55s sequential).

**Root cause:** SQLite single-writer serialization

- better-sqlite3 serializes writes even with concurrent operations
- Parallel parsing helps, but DB writes queue and serialize anyway
- `Promise.all()` coordination overhead adds latency without benefit

**Conclusion:** Sequential processing is optimal for current architecture. SQLite writes are the bottleneck, not CPU parsing.

**Reverted:** Code returned to simple sequential `for` loop.

---

## Current Performance (2026-03-06)

### Metrics

| Scenario | Duration | Throughput | Bandwidth | Utilization |
| --- | --- | --- | --- | --- |
| "Nothing new" refresh | 8.2s | — | — | — |
| Refresh with new messages | ~19s | — | — | — |
| Backward sync (7d, 523 msgs) | 71.55s | 7.31 msg/s | 1.29 MB/s | 2.0% of 650 Mbps |

### Phase Breakdown (7d backward sync)

| Phase | Duration | Notes |
| --- | --- | --- |
| Connect | 12.3s | TLS handshake |
| STATUS | 16.2s | Check for new messages |
| EXAMINE | 28.2s | Read-only mailbox open |
| Search | 32.1s | Find UIDs to fetch |
| Fetch + process | 36.7s | 2 batches × 300 messages |
| Checkpoint | 20.4s | Overlaps with fetch |

### Comparison with Baseline

| Metric | Baseline (60d) | Current | Improvement |
| --- | --- | --- | --- |
| "Nothing new" refresh | 42s | 8.2s | **5x faster** ✅ |
| Refresh with new messages | 42s | 19s | **2.2x faster** ✅ |
| Backward sync throughput | 8.9 msg/s | 7.31 msg/s | 2.2x faster |
| Backward sync bandwidth | 0.58 MB/s | 1.29 MB/s | **2.2x faster** |
| Bandwidth utilization | 0.7% | 2.0% | **2.9x improvement** |

---

## Current Bottlenecks

### Identified Bottlenecks

1. **SQLite write serialization** — Single-writer model serializes all inserts, limiting parallel processing benefits
2. **IMAP round-trips** — Each batch requires separate `fetchAll()` call (though 300-message batches help)
3. **TLS handshake** — 12-18s per sync (can't be eliminated without persistent connection)
4. **Bandwidth utilization** — Only 2.0% of 650 Mbps capacity (target: 50%+)

### Why We're Not Saturating the Wire

#### Current architecture

- Sequential batch processing (one batch at a time)
- Sequential message processing (parse → insert one at a time)
- SQLite writes serialize (single-writer)

#### To saturate the wire, we'd need

- Parallel batch fetching (2-3 batches concurrently)
- Batch SQLite inserts (collect parsed messages, insert in single transaction)
- Or: Separate parse/insert phases (parse all in parallel, then batch insert)

---

## Future Optimization Opportunities

See [OPP-010](./opportunities/OPP-010-sync-performance.md) for detailed roadmap.

### Priority 1: Batch SQLite Inserts

- Collect parsed messages, insert in single transaction
- May reduce write overhead
- Expected: 2-3x speedup for message processing phase

### Priority 2: Parallel Batch Fetching

- Fetch 2-3 batches concurrently with connection pooling
- May hit IMAP server rate limits (needs testing)
- Expected: 2-3x throughput improvement

### Priority 3: IMAP IDLE

- Persistent connection for daemon mode
- Eliminates 12s TLS reconnect for refresh cycles
- Best for incremental syncs, not backfills

### Priority 4: Larger Batch Sizes

- Test 400-500 for very large backfills (1y+)
- Low risk, easy to test

---

## Key Learnings

1. **Explicit UID arrays are better than sequence sets** — `fetchAll([1,2,3])` guarantees no gaps/duplicates, simpler code
2. **SQLite serialization limits parallelism** — Parallel processing doesn't help when DB writes serialize anyway
3. **STATUS fast path is huge win** — Early exit saves 20-36s for common "nothing new" case
4. **EXAMINE is faster than SELECT** — Read-only mailbox access is 2.4x faster for Gmail
5. **Batch size matters** — 300-message batches reduce IMAP round-trips by 4-10x
6. **Phase instrumentation is essential** — Enables data-driven optimization and regression detection

---

## Code Locations

**Main sync logic:** `src/sync/index.ts`

- `runSync()` — Main sync orchestration
- `processMessage()` — Per-message processing (parse → insert)

**Timer utility:** `src/lib/timer.ts`

- `withTimer()` — Shared timing helper for instrumentation

**Indexer:** `src/search/indexing.ts`

- `indexMessages()` — Async-pipelined indexing orchestration

**CLI entry points:** `src/cli/index.ts`

- `zmail refresh --since …` — Backfill command
- `zmail refresh` — Incremental forward sync command
