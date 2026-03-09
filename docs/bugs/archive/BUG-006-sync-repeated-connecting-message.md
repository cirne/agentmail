# BUG-006: Sync Repeated "Connecting" Message in Non-TTY Mode — Agent-Reported

**Status:** Fixed. Verified 2026-03-07; closed.

**Design lens:** [Agent-first](../../VISION.md) — agents run commands via subprocess with non-TTY stdio; TTY-specific output tricks degrade poorly and create confusing repeated messages.

**Reported context:** Agent on macOS (Darwin 25.3.0); running `zmail sync` from Claude Code subprocess (non-TTY stdio). Reproducibility: Always (in non-TTY mode).

---

## Summary

`zmail sync` prints "Connecting to IMAP server..." 11 times concatenated on a single line when run in non-TTY mode. The command attempts a TTY trick (likely cursor overwrite via `\r` or ANSI escape codes) to show a spinner or retry status on a single line. In non-TTY mode, each update appends as a new string instead of overwriting, resulting in the same message repeated many times.

---

## What the agent did (and what happened)

1. Configured zmail with valid credentials:
   ```bash
   zmail setup --email "user@gmail.com" --password "xxxx xxxx xxxx xxxx" --openai-key "sk-..."
   ```
2. Ran sync from a non-TTY context (Claude Code subprocess):
   ```bash
   zmail sync --since 7d
   ```
3. **Expected:** In non-TTY mode, either print "Connecting to IMAP server..." once, then print the next status update on a new line, OR suppress the spinner entirely and just print the final result.
4. **Actual:** The message appeared 11 times concatenated on a single line:
   ```
   Connecting to IMAP server at imap.gmail.com...Connecting to IMAP server at imap.gmail.com...Connecting to IMAP server at imap.gmail.com...Connecting to IMAP server at imap.gmail.com...Connecting to IMAP server at imap.gmail.com...Connecting to IMAP server at imap.gmail.com...Connecting to IMAP server at imap.gmail.com...Connecting to IMAP server at imap.gmail.com...Connecting to IMAP server at imap.gmail.com...Connecting to IMAP server at imap.gmail.com...Connecting to IMAP server at imap.gmail.com...Waiting for email... 300 synced (24s)
   ```

---

## Root causes

1. **TTY detection missing:** The sync command uses cursor overwrite (`\r`) or ANSI escape codes to update status on a single line, but doesn't check `process.stdout.isTTY` before attempting these tricks.
2. **Non-TTY degradation:** In non-TTY mode, `\r` doesn't overwrite — it just appends, causing repeated messages to concatenate.

---

## Recommendations (concise)

1. **Guard TTY tricks with `process.stdout.isTTY` check:**
   - **TTY mode:** Keep spinner/overwrite behavior as-is
   - **Non-TTY mode:** Print "Connecting to IMAP server..." once, then only print meaningful state changes (e.g., "300 synced", "Sync complete")
2. **Apply pattern broadly:** Any command using `\r`, ANSI cursor movement, or ora/spinner libraries should degrade gracefully for agent/pipe consumers.

---

## Fix

Guarded status writes in `src/cli/index.ts` (background sync poll loop) with `process.stdout.isTTY`. In non-TTY mode, "Connecting to IMAP server..." and "Waiting for email... X synced" are each printed at most once.

---

## References

- Vision (agent-first): [VISION.md](../../VISION.md)
- Related: [BUG-007](BUG-007-sync-silent-auth-failure.md), [BUG-009](BUG-009-wizard-crash-non-interactive.md)
