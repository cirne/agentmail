# BUG-004: Attachment Read Silent Failure — Agent-Reported

**Status:** Fixed (Verified 2026-03-07).

**Design lens:** [Agent-first](../VISION.md) — silent failures are especially harmful for LLM agents; without an error message, the agent cannot self-correct or understand what went wrong.

**Reported context:** Agent on macOS (Darwin 25.2.0); task was reading an attachment using numeric index as documented in `zmail read` output. Reproducibility: Always.

---

## Summary

`zmail attachment read` fails silently (exit code 1, no stdout/stderr) when given an invalid index such as `0`. The help text says `<index>|<filename>` but does not clarify 0-based vs 1-based indexing. Invalid input should always produce a descriptive error message on stderr.

---

## What the agent did (and what happened)

1. Read a message with attachments; output included:
   ```
   To read attachment: zmail attachment read "<message-id>" <index>|<filename>
   ```
2. Attempted to read attachment by index:
   ```bash
   zmail attachment read "<message-id>" 0
   ```
3. **Actual result:** Exit code 1 with no output at all — completely silent failure.

---

## Root causes

1. **Index base ambiguity:** Help text does not clarify that index is 1-based. Agent tried 0 (common 0-based convention).
2. **Silent failure:** On invalid input, the CLI may exit with code 1 without emitting any error message to stderr. (Note: Current code at `src/cli/index.ts` lines 1146–1148 does emit `console.error` when attachment is not found; the silent failure may occur in a different code path, e.g. message ID normalization or config loading, or the error may be swallowed in some invocation context.)

---

## Recommendations (concise)

1. **Always emit an error message on non-zero exit** — ensure every failure path writes to stderr before `process.exit(1)`.
2. **Clarify index base in help text** — e.g. show `[1] filename.xlsx` in attachment listing, or document "index 1-based" explicitly.
3. **Consider accepting both 0-based and 1-based** — or pick one and document it clearly.

---

## Workaround

Use the filename instead of the index:
```bash
zmail attachment read "<message-id>" "filename.xlsx"
```

---

## Verification

- **Status:** Verified
- **Date:** 2026-03-07
- **Result:** Fix confirmed. Index 0 now returns a clear error: `No attachment "0" in this message. Use index 1-1 or exact filename.` Index 1 correctly reads the attachment. The error message clearly indicates 1-based indexing and the valid range.
- **Tested with:** `zmail attachment read "<CH3PR84MB38746104F19C2113B72E38DBFD7AA@CH3PR84MB3874.NAMPRD84.PROD.OUTLOOK.COM>" 0` and `zmail attachment read "..." 1`

---

## References

- Vision (agent-first): [VISION.md](../VISION.md)
- Related: [BUG-001](archive/BUG-001-attachment-and-read-agent-friction.md), [BUG-002](archive/BUG-002-attachment-discoverability-and-read.md)
