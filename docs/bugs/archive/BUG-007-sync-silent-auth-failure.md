# BUG-007: Sync Silent Authentication Failure — Agent-Reported

**Status:** Fixed. Verified 2026-03-07; closed.

**Design lens:** [Agent-first](../VISION.md) — silent failures are especially harmful for LLM agents; without an error message, the agent cannot self-correct or understand what went wrong. This is the most critical onboarding bug: a user who typos their password will think everything worked, proceed to search, get 0 results, and have no idea why.

**Reported context:** Agent on macOS (Darwin 25.3.0); config with invalid IMAP credentials set up via `zmail setup --no-validate`. Reproducibility: Always (with invalid IMAP credentials).

---

## Summary

After running `zmail setup --no-validate` with invalid credentials, `zmail sync` reports "Sync complete! 0 messages synced and indexed" with exit code 0, even though the background sync process crashed during IMAP connection. The sync log shows the process got stuck at `lock_acquired` phase and never progressed — no error was logged. The foreground process apparently doesn't wait for the background sync to confirm IMAP auth before printing the success message.

---

## What the agent did (and what happened)

1. Set up with invalid credentials:
   ```bash
   zmail setup --email "test@gmail.com" --password "fake-password" --openai-key "sk-fake123" --no-validate
   ```
2. Ran sync:
   ```bash
   zmail sync --since 7d
   ```
3. **Expected:** Error message indicating IMAP connection/authentication failure, with exit code 1. Example:
   ```
   Sync failed: Could not authenticate with IMAP server. Check your credentials.
   ```
4. **Actual:** Success message with exit code 0:
   ```
   Connecting to IMAP server at imap.gmail.com...

   Sync running in background.
     PID:    38552
     Log:    /Users/cirne/.zmail/logs/sync.log
     Status: zmail status

   Sync complete! 0 messages synced and indexed.
   Try: zmail search "your query"  |  zmail who "name"
   ```
   The sync log (`~/.zmail/logs/sync.log`) shows the process got stuck at `lock_acquired` phase and never progressed — only 5 lines written, ending at:
   ```
   [2026-03-07T15:36:33.839Z] INFO  Phase {"phase":"lock_acquired","elapsedMs":19}
   ```
   No error was logged. The background process crashed silently.

---

## Root causes

1. **Foreground doesn't wait for auth:** The foreground process doesn't wait for the background sync to confirm IMAP authentication before printing the success message.
2. **Background crash not surfaced:** The background sync process crashes silently during IMAP connection, but the error is never logged or reported back to the foreground process.
3. **"0 messages" not flagged:** The "0 messages synced" output should at minimum trigger a warning like "No messages found — check your credentials and date range."

---

## Recommendations (concise)

1. **Validate IMAP connection before backgrounding:** Consider validating IMAP connection *before* backgrounding the sync, so auth errors surface immediately.
2. **Wait for initial auth confirmation:** The foreground process should wait for the background sync to confirm successful IMAP authentication before printing success.
3. **Surface background errors:** Background sync errors (including auth failures) should be logged and reported back to the foreground process.
4. **Warn on 0 messages:** When 0 messages are synced, emit a warning suggesting the user check credentials and date range.

---

## Fix

Fixed by:
1. Explicitly catching and logging IMAP connection errors in `src/sync/index.ts`
2. Adding `checkSyncLogForErrors()` function to parse sync log for errors
3. Checking sync log before printing success message in background sync mode
4. Adding warnings when 0 messages are synced (may indicate auth failure)

Test case: `src/cli/sync-auth-failure.test.ts` verifies the fix.

## References

- Vision (agent-first): [VISION.md](../VISION.md)
- Related: [BUG-006](BUG-006-sync-repeated-connecting-message.md), [BUG-004](BUG-004-attachment-read-silent-failure.md)
