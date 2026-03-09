# BUG-010: Sync Backward Resume Skips Requested Date Range — Agent-Reported

**Status:** Fixed. Verified 2026-03-07; closed.

**Design lens:** [Agent-first](../VISION.md) — agents expanding their search window (e.g., "search emails from 3 months ago") silently get no additional data. No error, no warning — the narrow range persists, breaking the agent's mental model.

**Reported context:** Agent on macOS (Darwin 25.3.0); data: 507 emails, 2026-02-28 to 2026-03-07. Reproducibility: Always (when requesting wider range than existing sync).

---

## Summary

When a user syncs a narrow date range (e.g., `--since 7d`) and later requests a wider range (e.g., `--since 90d`), the backward sync resume logic uses the oldest synced date as the IMAP SEARCH boundary instead of the requested date. The older messages are never fetched, and the range silently stays unchanged.

---

## What the agent did (and what happened)

1. Ran `zmail sync --since 7d` — synced 507 messages covering 2026-02-28 to 2026-03-07.
2. Ran `zmail sync --since 90d` — expected range to expand to ~2025-12-07.
3. Ran `zmail status` — range still showed `2026-02-28 .. 2026-03-07`. Only 1 new message fetched (a genuinely new arrival), not the older backfill.

Sync log confirmed the issue:
```
Resuming backward sync from oldest synced date with UID filtering
  requestedSince: "2025-12-07"       ← correct: 90 days back
  oldestSynced: "2026-02-28"         ← existing data boundary
  resumingFrom: "2026-02-28"         ← BUG: resumes from here, not Dec 7

Backward sync (filling gaps)
  since: "2026-02-28"               ← searches from Feb 28, not Dec 7
  requestedSince: "2025-12-07"      ← knows the real target but ignores it

Filtered UIDs using last_uid checkpoint
  beforeFilter: 507
  afterFilter: 1                    ← only 1 new message
  filtered: 506                     ← all existing messages filtered as "already seen"
```

The IMAP SEARCH uses `oldestSynced` as the date boundary instead of `requestedSince`, then UID-filters out all known messages, finds only 1 new one, and declares sync complete — never looking at the unfetched date range (Dec 7 through Feb 27).

---

## Root causes

1. **Backward sync resume uses wrong date boundary:** When resuming, the sync engine uses `oldestSynced` (the oldest date already in the DB) as the IMAP SEARCH `SINCE` parameter, rather than `requestedSince` (the date the user actually asked for).
2. **UID filtering masks the problem:** After the too-narrow IMAP SEARCH, UID filtering correctly removes already-seen messages — but since the search never included the missing date range, there's nothing new to find.
3. **No detection of range expansion:** The sync engine doesn't compare `requestedSince` against `oldestSynced` to detect that the user is asking for a wider range than what's already been synced.

---

## Recommendations (concise)

1. **Use `min(requestedSince, oldestSynced)` as the IMAP SEARCH date boundary.** When `requestedSince < oldestSynced`, the search must start from `requestedSince` to cover the unfetched date range. UID filtering will still correctly skip already-fetched messages.
2. **Log a clear message when expanding the sync range** (e.g., "Expanding sync range from 2026-02-28 back to 2025-12-07") so agents and users can see the backfill happening.
3. **Consider a `status` output hint** when the synced range is narrower than what was last requested, to make the gap visible.

---

## Fix

Fixed in `src/sync/index.ts` (lines 406-407): Changed backward sync resume logic to use `fromDate` (requested date) instead of `oldestDateStr` (oldest synced date) when `oldestDay > requestedDay` (user requesting wider range). The IMAP SEARCH now correctly starts from the requested date, covering the unfetched date range. UID filtering still correctly skips already-fetched messages.

Updated log messages to "Expanding sync range backward" to clarify behavior.

---

## References

- Vision (agent-first): [VISION.md](../VISION.md)
- Sync engine: `src/sync/`
- Related (sync bugs): [BUG-006](archive/BUG-006-sync-repeated-connecting-message.md), [BUG-007](archive/BUG-007-sync-silent-auth-failure.md)
