# BUG-019: Refresh Reports No New Messages Despite New Mail in Inbox

**Status:** Fixed (archived 2026-03-09).

**Reported context:** User ran `zmail refresh`; two new emails (auth passcodes) were present in their inbox, but refresh reported nothing (0 new, 0 fetched).

---

## Summary

Refresh uses a STATUS-based early exit: if the server reports `UIDNEXT - 1 <= last_uid`, we skip opening the mailbox and fetching, and return immediately. When that happens, the CLI shows "0 new, 0 fetched" with no indication that we *skipped* the fetch. In some cases the server can report no new messages when there actually are (e.g. stale STATUS, or the messages live in a folder we don’t sync), so the user sees “nothing happened” even though mail arrived.

---

## Possible causes

1. **STATUS early exit** — Server returned `UIDNEXT` such that we concluded there were no new messages; either the server was stale/cached or there is a logic bug in the comparison.
2. **Single mailbox** — We only sync one mailbox: `[Gmail]/All Mail` for Gmail, or `INBOX` for other providers. If the two emails were delivered to a different folder (e.g. a subfolder or another label that isn’t the synced mailbox), we would never see them. Gmail’s All Mail contains everything; other providers may deliver to INBOX subfolders we don’t sync.
3. **Checkpoint vs reality** — In theory `last_uid` is only advanced after we persist a batch; if an old bug or crash left `last_uid` ahead of what we actually have, we could skip UIDs. Unlikely if checkpoint logic is correct.

---

## Diagnostics

1. Run **`zmail status --imap`** (or `--json` with `--imap`) and check:
   - **Server** vs **Local** message counts and `UIDNEXT` / `last_uid`.
   - If it shows **Missing: N new message(s)**, the server has more mail than we’ve synced; refresh *should* have fetched them unless we exited early.
2. Check the **latest sync log** (`~/.zmail/logs/sync.log` or path from CLI):
   - Look for **"Early exit: no new messages"** — confirms we skipped fetch based on STATUS.
   - Look at **"STATUS response"** and **"Early exit check"** to see `uidNext`, `lastKnownUid`, and `shouldEarlyExit`.

---

## Recommendations

1. **`zmail refresh --force`** — Skip the STATUS early exit and always run SEARCH + fetch. Lets users force a full check when they know new mail arrived. Implemented in this bug.
2. **Clear early-exit message** — When refresh returns without fetching and we early-exited, print e.g. **"No new messages (skipped fetch)."** so the user knows we checked and skipped, rather than implying “nothing ran.”
3. **Document which mailbox is synced** — In help or docs, state that we sync only one mailbox (All Mail for Gmail, INBOX for others) so users know that other folders are not synced.
4. **Optional:** If STATUS is known to be unreliable for a provider, consider skipping early exit for that host (e.g. via config) or defaulting to a full check for non-Gmail.

---

## References

- Sync design: [SYNC.md](../../SYNC.md) — STATUS fast path, forward sync
- Sync implementation: `src/sync/index.ts` (early exit, checkpoint)
- Status comparison: `src/lib/status.ts` — `getImapServerStatus`, missing count
- Config mailbox: `config.sync.mailbox` or `getSyncMailbox(host)` in `src/sync/index.ts`
