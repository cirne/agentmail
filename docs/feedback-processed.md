# Processed Feedback

This file tracks feedback files from `../ztest/feedback/` that have been processed. A feedback item is considered "processed" when we have decided what to do with it and completed that action (ignore, create bug, create opportunity, update docs, etc.).

**Format:** Each entry includes:
- Feedback filename
- Date processed
- Action taken (bug created, opportunity created, ignored, etc.)
- Related bug/opportunity ID (if applicable)

---

## Processed Items

| Feedback File | Date Processed | Action | Related ID |
|---|---|---|---|
| `ux-semantic-search-guidance.md` | 2026-03-06 | Created bug | [BUG-003](bugs/archive/BUG-003-fts-vs-semantic-search-guidance.md) — Superseded by OPP-008 |
| `ux-simplify-search-modes.md` | 2026-03-06 | Created opportunity | [OPP-008](opportunities/archive/OPP-008-simplify-search-modes.md) — Implemented 2026-03-06 |
| `bug-attachment-read-silent-failure.md` | 2026-03-06 | Created bug | [BUG-004](bugs/archive/BUG-004-attachment-read-silent-failure.md) |
| `bug-xlsx-object-object-rendering.md` | 2026-03-06 | Created bug | [BUG-005](bugs/archive/BUG-005-xlsx-formula-cells-object-object.md) |
| `bug-sync-repeated-connecting-message.md` | 2026-03-07 | Created bug | [BUG-006](bugs/archive/BUG-006-sync-repeated-connecting-message.md) |
| `bug-sync-silent-auth-failure.md` | 2026-03-07 | Created bug | [BUG-007](bugs/archive/BUG-007-sync-silent-auth-failure.md) |
| `bug-who-case-sensitive-email-dedup.md` | 2026-03-07 | Created bug | [BUG-008](bugs/archive/BUG-008-who-case-sensitive-email-dedup.md) |
| `bug-wizard-crash-non-interactive.md` | 2026-03-07 | Created bug | [BUG-009](bugs/archive/BUG-009-wizard-crash-non-interactive.md) |
| `feature-who-smart-address-book.md` | 2026-03-07 | Created opportunity | [OPP-012](opportunities/OPP-012-who-smart-address-book.md) |
| `bug-sync-backward-resume-skips-date-range.md` | 2026-03-07 | Created bug | [BUG-010](bugs/archive/BUG-010-sync-backward-resume-skips-date-range.md) |
| `bug-who-dartmouth-not-merged.md` | 2026-03-07 | Created bug | [BUG-011](bugs/archive/BUG-011-who-dartmouth-not-merged.md) |
| `bug-who-min-sent-splits-identity.md` | 2026-03-07 | Created bug | [BUG-012](bugs/archive/BUG-012-who-min-sent-splits-identity.md) |
| `bug-who-noreply-display-name-leaks.md` | 2026-03-07 | Created bug | [BUG-013](bugs/archive/BUG-013-who-noreply-display-name-leaks.md) |
| `bug-who-signature-parser-noise.md` | 2026-03-07 | Created bug | [BUG-014](bugs/archive/BUG-014-who-signature-parser-noise.md) |
| `ux-who-name-inference-from-address.md` | 2026-03-07 | Created opportunity | [OPP-013 archived](opportunities/archive/OPP-013-who-name-inference-from-address.md) → [OPP-012](opportunities/OPP-012-who-smart-address-book.md) — Partial: dot/underscore patterns work, firstlast (no separator) still null |
| `bug-who-name-inference-noreply-garbage.md` | 2026-03-07 | Created bug | [BUG-015](bugs/archive/BUG-015-who-name-inference-noreply-garbage.md) |
| `bakeoff-results.md` | 2026-03-07 | Created bug | [BUG-016](bugs/archive/BUG-016-bakeoff-incomplete-coverage-critical.md) — Archived 2026-03-10; domain→from scope → BUG-020 |
| `bug-search-silent-truncation-and-fts-dot-syntax.md` | 2026-03-07 | Updated existing bug | [BUG-016](bugs/archive/BUG-016-bakeoff-incomplete-coverage-critical.md) — Post-fix retest; archived 2026-03-10 |
| `bakeoff-001-rudy-funds.md` | 2026-03-07 | Created opportunity | [OPP-018](opportunities/archive/OPP-018-reduce-agent-round-trips.md) — body preview + richer search output |
| `bakeoff-002-entrepreneur-meeting.md` | 2026-03-07 | Created bug | [BUG-017](bugs/BUG-017-semantic-recall-gap-intent-queries.md) — semantic recall gap for intent queries |
| `bakeoff-003-news-headlines.md` | 2026-03-07 | Created opportunity | [OPP-018](opportunities/archive/OPP-018-reduce-agent-round-trips.md) — newsletter detection + body preview |
| `bakeoff-004-tech-news.md` | 2026-03-07 | Created opportunity | [OPP-018](opportunities/archive/OPP-018-reduce-agent-round-trips.md) — primary source: batch get_message + richer search output |
| `bakeoff-005-entrepreneur-rematch.md` | 2026-03-07 | Created opportunity + bug, updated existing bug | [OPP-019 archived](opportunities/archive/OPP-019-fts-first-retire-semantic-default.md) (FTS-first); [BUG-018](bugs/BUG-018-who-timings-unknown-flag.md) (who --timings); [BUG-017](bugs/BUG-017-semantic-recall-gap-intent-queries.md) updated with resolution path |
| `bakeoff-results.md` (updated v2) | 2026-03-07 | Index update noted | Bakeoff #5 added to index; strategic insight → [OPP-019 archived](opportunities/archive/OPP-019-fts-first-retire-semantic-default.md) |
| `bug-read-prepare-error.md` | 2026-03-09 | Created bug | [BUG-021](bugs/BUG-021-read-prepare-error.md) — `read`/`get_messages` crash with prepare error |
| `ux-ask-default-detail-level.md` | 2026-03-09 | Created opportunity | [OPP-022](opportunities/OPP-022-ask-synthesis-detail-level.md) — Mini synthesis too shallow for broad queries |
| `ux-ask-inbox-includes-spam.md` | 2026-03-09 | Matched existing opportunity; partially fixed | [OPP-021](opportunities/OPP-021-ask-spam-promo-awareness.md) — Schema version bumped (4→5) to force re-index with noise classification |
| `bug-attachments-missing-from-email.md` | 2026-03-09 | Created bug; fixed; verified | [BUG-023](bugs/archive/BUG-023-attachments-missing-from-synced-email.md) — Attachment filter bug fixed (schema v8→9); recovered 14 attachments; user verified closed |
| `feature-get-messages-token-efficiency.md` | 2026-03-24 | Matched existing opportunity; MCP `get_messages` result order aligned with `messageIds` | [OPP-018](opportunities/archive/OPP-018-reduce-agent-round-trips.md) — archived 2026-03-24; profiles + batch auto-summary shipped |
| `feature-search-slim-results.md` | 2026-03-24 | Fixed in place | CLI + MCP search: auto slim JSON when more than 50 results; `format` + hint; `--result-format` / `resultFormat` — `src/search/search-json-format.ts` |
| `feature-attachment-metadata-in-search.md` | 2026-03-24 | Fixed in place | Full JSON search: `attachments` array with `id`, `filename`, `mimeType`, `size`, `extracted`, `index`; slim rows: count + `attachmentTypes` — `src/cli/index.ts`, `src/search/search-json-format.ts`, `src/attachments/list-for-message.ts`, `src/lib/types.ts` |
| `bug-inbox-text-utf8-panic.md` | 2026-03-30 | Created bug, fixed | [BUG-028 archived](bugs/archive/BUG-028-inbox-text-utf8-snippet-panic.md) — `inbox --text`: `wrap_line` uses `floor_char_boundary` |
| `bug-read-bare-message-id-query-returned-no-rows.md` | 2026-03-31 | Created bug; fixed; verified | [BUG-029 archived](bugs/archive/BUG-029-read-bare-message-id-no-angle-brackets.md) — ID lookup tries `<id>` then bare `id`; closed after verification |
| `bug-draft-view-and-send-hang-sigkill.md` | 2026-03-31 | Created bug; fixed & verified | [BUG-030 archived](bugs/archive/BUG-030-draft-commands-hang-after-edit.md) — lazy DB open; closed 2026-03-31 |
| `bug-send-reply-draft-wrong-path.md` | 2026-03-31 | Created bug; fixed; verified | [BUG-031](bugs/archive/BUG-031-send-reply-draft-wrong-maildir-path.md) — reply send path resolution fixed; user verified closed |
| `ux-search-query-optional-when-filters-present.md` | 2026-03-31 | Created bug | [BUG-032](bugs/BUG-032-search-query-should-be-optional-with-filters.md) — CLI requires positional `<QUERY>` even when filters already define a valid search |
| `ux-actionable-error-messages.md` | 2026-03-31 | Created bug | [BUG-033](bugs/BUG-033-actionable-file-not-found-errors.md) — missing local files still surface raw OS/path errors instead of actionable zmail-specific recovery messages |
| `ux-cli-agent-friction-and-read-missing-recipients.md` | 2026-04-01 | Created bugs | [BUG-034](bugs/archive/BUG-034-cli-json-text-flags-inconsistent-across-subcommands.md) (CLI `--json`/`--text` friction); [BUG-035](bugs/archive/BUG-035-read-omits-to-cc-bcc-and-threading-headers.md) (`read` omits To/CC/BCC / threading headers) |
| `bug-check-ignores-same-day-flight.md` | 2026-04-03 | Matched existing bug; extended context | [BUG-024](bugs/archive/BUG-024-inbox-scan-over-filters-misses-important-mail.md) — `zmail check` same-day NetJets tail notification classified `ignore`; Rust prompt/refs updated |

---

## Notes

- This file serves as the source of truth for which feedback has been processed
- Always check this file first before processing feedback to avoid duplicates
- After processing feedback, add an entry here and optionally delete/move the feedback file
- Feedback files can be safely deleted after processing if they're tracked here
