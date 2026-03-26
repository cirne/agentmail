# BUG-001: Attachment and Read/Thread Friction — Agent-Reported

**Status: Fixed (archived).** PDF-in-binary resolved by OPP-007 (Node/npm). Remaining items (read/thread ID normalization, attachment read syntax, extract-vs-download hints) have been addressed or documented.

**Design lens:** [Agent-first](../../VISION.md) — when an agent tries something that doesn't work, we want to know **why**. Is the CLI intuitive enough for the LLM?  
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
| 7 | `zmail attachment read 13` (PDF) | ✅ **Resolved** — distribution is Node.js (`npm i -g zmail`); PDF extraction works. |

---

## Root causes

### 1. `read` / `thread` require exact stored ID (including angle brackets)

- **Stored format:** `message_id` and `thread_id` in SQLite include angle brackets (e.g. `<1403139019.995.1772659122361@[169.254.89.5]>`).
- **Search output:** JSON uses `messageId` / `threadId`; the actual string in the payload often includes `<>`. If the agent (or user) strips brackets or normalizes the ID, lookup fails.
- **CLI behavior:** No normalization or hint. `WHERE message_id = ?` / `WHERE thread_id = ?` return no row → `null` / `[]` with no explanation.

### 2. `attachment read` argument order and semantics

- **Actual usage:** `zmail attachment read <attachment_id> [--raw]`. Only one positional arg: the numeric attachment ID from `attachment list`.
- **What the agent tried:** `zmail attachment read "<message_id>" 16` — message ID first, then attachment ID, as if "read attachment 16 from this message."
- **Result:** First argument is parsed as attachment ID; the string `"<...>"` is not a number → clear error, but the **intent** (message + attachment) is natural for an LLM.

### 3. `attachment read` without `--raw`: extraction vs download

- **Design:** Without `--raw`, the CLI **extracts** supported types (XLSX → CSV, PDF → text, etc.) and prints text. With `--raw`, it streams the binary unchanged.
- **Agent intent:** "Download the spreadsheet" → expect raw file. Agent used `zmail attachment read 16 > file.xlsx` and got CSV text in a file named .xlsx.
- **No hint** that for "download binary" the user/agent must pass `--raw`.

### 4. PDF extraction in compiled binary — resolved

- **Resolution:** [OPP-007](../../opportunities/archive/OPP-007-packaging-npm-homebrew.md) moved distribution to Node.js; the compiled binary is no longer shipped. Install via `curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | bash` (or `npm run install-cli` from a clone: build + global install). PDF extraction works in the supported runtime.

---

## Recommendations (concise)

1. **Read/thread IDs:** Normalize message/thread IDs (accept with or without `<>`) and/or return a brief, corrective hint when no row is found.
2. **Attachment read syntax:** Keep single-arg `attachment read <id>` but improve help and error message so the "list by message, read by attachment id" model is obvious; optionally add a hint when the first arg looks like a message ID.
3. **Extract vs download:** Document and hint: "Use `--raw` to download the original file; without it we extract text (e.g. XLSX→CSV)."
4. **PDF in compiled binary:** Resolved — binary removed; distribution is Node.js via npm (OPP-007).

---

## References

- Vision (agent-first, agent-intuitive): [VISION.md](../../VISION.md)
- CLI attachment usage: `zmail attachment list <message_id>`; `zmail attachment read <attachment_id> [--raw]`
