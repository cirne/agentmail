# BUG-002: Attachment Discoverability and Read — Agent-Reported

**Status: Fixed.** (2026-03-06)

**Design lens:** [Agent-first](../../VISION.md) — when an agent tries to get attachment content (e.g. Excel as markdown/CSV), the path from "found the email" to "got the extracted content" should be discoverable from help and behavior.

**Fixed by:**
- Updated `formatMessageLlmFriendly` to show attachment summary (count, filenames, extraction status) and hints for retrieving attachments
- Added attachment commands to `CLI_USAGE` constant so `zmail --help` shows them
- Added comprehensive test coverage for attachment display

**Reported context:** Agent (Claude) on macOS; task was retrieve Excel spreadsheets from NetJets billing emails (flight activity for Green Longhorn Air LLC). Agent used search → read → thread; never discovered `zmail attachment list` / `zmail attachment read`.

---

## Summary

An agent was asked to retrieve Excel spreadsheets from NetJets billing emails in an agent-friendly format (markdown or CSV). It used `zmail search`, then `zmail read`, and only found attachment metadata (including "extracted: true" for an XLSX) via `zmail thread`. It found no documented way to actually retrieve the extracted content. The attachment subcommands (`attachment list`, `attachment read`) were never discovered; `read` does not show attachments; and search does not expose attachment filenames or extracted content.

---

## What the agent did (and what happened)

| Step | Agent action | Result |
|------|----------------|--------|
| 1 | `zmail --help` | ✅ Saw commands: setup, sync, refresh, search, who, status, stats, thread, read, mcp. No `attachment` in main help. |
| 2 | `zmail search "from:netjets billing" --limit 50 --detail body` | ✅ Found 6 billing emails; body text only, no attachment info. |
| 3 | `zmail search "from:netjets excel OR spreadsheet OR xlsx OR csv"` | ❌ Empty — attachments not indexed by filename/content. |
| 4 | `zmail read "<messageId>"` | ❌ Message metadata and body only; **no attachment information**. |
| 5 | `zmail read --help` | Only `--raw` flag; no attachment-related options. |
| 6 | `zmail thread "<threadId>"` | ✅ **Only success:** JSON included `attachments` array with filenames, MIME types, and `extracted: true` for the XLSX. |
| 7 | Look for way to get extracted content | ❌ No documented path. Tried `~/.zmail/attachments/`, raw EML; no discovery of `zmail attachment read <id>`. |

---

## Root causes

### 1. `zmail read` does not show attachments

- **Current behavior:** `read` returns message metadata and body only. No attachment list, IDs, or extraction status.
- **Agent expectation:** After finding the right message, "read" is the natural next step; agent expected to see attachments (or a hint) there.
- **Gap:** Attachment discovery only happens via `zmail thread` (or knowing `zmail attachment list <messageId>`). Neither is suggested by `read` or its help.

### 2. Attachment subcommands not discoverable from main help

- **Current behavior:** `zmail --help` lists setup, sync, refresh, search, who, status, stats, thread, read, mcp. Attachment commands exist (`zmail attachment list`, `zmail attachment read`) but are not listed in top-level help.
- **Agent behavior:** Agent never ran `zmail attachment`; had no cue that "attachment" is a subcommand. After seeing "extracted: true" in thread output, still had no way to get that content.

### 3. No path from "extracted: true" to content

- **Current behavior:** `thread` output includes `attachments[].extracted` and filenames but no attachment IDs. To get content you must call `zmail attachment list <messageId>` to get IDs, then `zmail attachment read <attachmentId>`.
- **Gap:** Thread JSON does not document or link to this flow; help for `thread` does not say how to retrieve extracted content. Agent concluded there is "no documented, agent-friendly way to retrieve and view that extracted content."

### 4. Search does not index attachment metadata or content

- **Current behavior:** Full-text search does not include attachment filenames or extracted body text. Queries like "excel OR xlsx OR spreadsheet" return no results when only attachment names/content match.
- **Agent impact:** Agent could not narrow results by attachment type; had to scan subject/body only.

---

## Recommendations (concise)

1. **`zmail read`:** Include attachment summary (count, filenames, extraction status) and/or a one-line hint: "Attachments: list with `zmail attachment list <messageId>`; read with `zmail attachment read <attachmentId>`."
2. **Top-level help:** List `attachment` in `zmail --help` (e.g. "attachment — list/read attachments") so agents and users can discover it.
3. **Thread output / help:** In `zmail thread` help or output, add a short note that extracted content is retrieved with `zmail attachment read <attachmentId>` (IDs from `zmail attachment list <messageId>`).
4. **Search (future):** Consider indexing attachment filenames and, where feasible, extracted text so search can match "xlsx", "spreadsheet", etc.

---

## References

- Vision (agent-first): [VISION.md](../../VISION.md)
- Related: [BUG-001 (attachment/read friction)](archive/BUG-001-attachment-and-read-agent-friction.md) — argument order, extract vs `--raw`, ID normalization (fixed/archived).
- CLI attachment usage: `zmail attachment list <message_id>`; `zmail attachment read <attachment_id> [--raw]` (see [AGENTS.md](../../AGENTS.md)).
