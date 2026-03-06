# BUG-001: Attachment and Read/Thread Friction — Agent-Reported

**Design lens:** [Agent-first](../../VISION.md) — when an agent tries something that doesn’t work, we want to know **why**. Is the CLI not intuitive enough for the LLM?  
**Reported context:** Agent (Claude) on macOS; task was find email from billing@netjets.com and download attached spreadsheet; test message Feb 2026 invoice.

---

## Summary

An agent (Claude) was asked to find an email from `billing@netjets.com` and download an attached spreadsheet. It succeeded at search and `zmail attachment list`, then hit several failures: `zmail read` and `zmail thread` returned null/empty, `zmail attachment read` was used with the wrong argument order, the spreadsheet was obtained as extracted CSV instead of raw XLSX, and PDF extraction failed in the compiled binary. This bug doc captures root causes and the agent-intuitive questions they raise.

---

## What the agent did (and what happened)

| Step | Agent action | Result |
|------|----------------|--------|
| 1 | `zmail search "from:billing@netjets.com"` | ✅ Found messages; got `messageId` in JSON (e.g. with angle brackets in payload). |
| 2 | `zmail attachment list "<messageId>"` | ✅ Listed attachments; got numeric `id` (e.g. 16) and filenames. |
| 3 | `zmail read "<messageId>"` or `zmail read "messageIdWithoutBrackets"` | ❌ `null` when ID was passed **without** angle brackets. |
| 4 | `zmail thread "threadIdWithoutBrackets"` | ❌ `[]` when thread ID was passed **without** angle brackets. |
| 5 | `zmail attachment read "<messageId>" 16` (message ID first) | ❌ Error: "Invalid attachment ID … Must be a positive number." |
| 6 | `zmail attachment read 16` (no `--raw`) | ⚠️ Output was **extracted CSV text** (~1.3 KB), not raw XLSX (11.6 KB). Agent expected a binary file. |
| 7 | `zmail attachment read 13` (PDF) | ❌ In **compiled binary only**: "Cannot find module './pdf.js/v1.10.100/build/pdf.js' from '/$bunfs/root/zmail'". With `bun run src/index.ts` PDF extraction works. |

---

## Root causes

### 1. `read` / `thread` require exact stored ID (including angle brackets)

- **Stored format:** `message_id` and `thread_id` in SQLite include angle brackets (e.g. `<1403139019.995.1772659122361@[169.254.89.5]>`).
- **Search output:** JSON uses `messageId` / `threadId`; the actual string in the payload often includes `<>`. If the agent (or user) strips brackets or normalizes the ID, lookup fails.
- **CLI behavior:** No normalization or hint. `WHERE message_id = ?` / `WHERE thread_id = ?` return no row → `null` / `[]` with no explanation.

**Agent-intuitive question:** Should we accept IDs with or without angle brackets and normalize before lookup? Should we print a one-line hint when no message/thread is found (e.g. “No message found for that ID. Try including angle brackets, e.g. \<id\>.”)?

### 2. `attachment read` argument order and semantics

- **Actual usage:** `zmail attachment read <attachment_id> [--raw]`. Only one positional arg: the numeric attachment ID from `attachment list`.
- **What the agent tried:** `zmail attachment read "<message_id>" 16` — message ID first, then attachment ID, as if “read attachment 16 from this message.”
- **Result:** First argument is parsed as attachment ID; the string `"<...>"` is not a number → clear error, but the **intent** (message + attachment) is natural for an LLM.

**Agent-intuitive question:** Is “attachment read \<attachment_id\>” discoverable enough given that `attachment list` takes \<message_id\>? Do we want a variant that takes (message_id, attachment_id) or do we improve help/errors so the agent learns “list by message, read by attachment id” in one failure?

### 3. `attachment read` without `--raw`: extraction vs download

- **Design:** Without `--raw`, the CLI **extracts** supported types (XLSX → CSV, PDF → text, etc.) and prints text. With `--raw`, it streams the binary unchanged.
- **Agent intent:** “Download the spreadsheet” → expect raw file. Agent used `zmail attachment read 16 > file.xlsx` and got CSV text in a file named .xlsx.
- **No hint** that for “download binary” the user/agent must pass `--raw`.

**Agent-intuitive question:** Should we add a short hint when stdout is a TTY and the attachment is binary (e.g. “To download the original file, use: zmail attachment read \<id\> --raw”) or when the output is clearly extracted (e.g. “Extracted text. Use --raw for binary.”)? Should help text make “extract vs download” explicit in one line?

### 4. PDF extraction in compiled binary

- **Observation:** With `bun run src/index.ts`, `zmail attachment read 13` (PDF) succeeds. With the compiled binary (`./dist/zmail`), the same command fails: `Cannot find module './pdf.js/v1.10.100/build/pdf.js' from '/$bunfs/root/zmail'`.
- **Cause:** `@cedrugs/pdf-parse` (or its dependency) resolves `pdf.js` via a relative path that exists in `node_modules` at dev time but is not present or resolvable inside the compiled binary.
- **Scope:** Only affects **compiled** zmail; dev/source path is fine.

**Agent-intuitive question:** For agents that use the installed binary (e.g. release or `bun run install-cli`), PDF extraction is broken. Do we fix bundling, or document “use source for PDF extraction” and/or fail with a clear message (“PDF extraction not available in this build”) instead of a module resolution error?

---

## Reproduction

All of the above were reproduced locally (same data, same config):

- **With compiled binary:** `./dist/zmail` — Attempts 1–6 match the user report; Attempt 6 (PDF) fails with the pdf.js module error.
- **With source:** `bun run src/index.ts ...` — Attempts 1–5 identical; Attempt 6 (PDF) **succeeds**.

So: issues 1–5 are CLI/UX and affect both; issue 6 is bundling/runtime and affects only the compiled binary.

---

## Recommendations (concise)

1. **Read/thread IDs:** Normalize message/thread IDs (accept with or without `<>`) and/or return a brief, corrective hint when no row is found.
2. **Attachment read syntax:** Keep single-arg `attachment read <id>` but improve help and error message so the “list by message, read by attachment id” model is obvious; optionally add a hint when the first arg looks like a message ID.
3. **Extract vs download:** Document and hint: “Use `--raw` to download the original file; without it we extract text (e.g. XLSX→CSV).”
4. **PDF in compiled binary:** Fix bundling of pdf.js for the compiled build, or replace with an extractor that bundles cleanly, or fail with a clear “PDF extraction not available in this build” message.

---

## References

- Vision (agent-first, agent-intuitive): [VISION.md](../../VISION.md) — “When invocations fail, we output token-efficient, corrective help so the LLM can self-correct.”
- CLI attachment usage: `zmail attachment list <message_id>`; `zmail attachment read <attachment_id> [--raw]`
