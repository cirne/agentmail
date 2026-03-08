# Bugs — Agent and User Reports

When an agent or user hits a failure, we document it here. Root cause and "agent-intuitive" implications matter: **is the CLI intuitive enough for the LLM?** See [VISION.md](./VISION.md) (agent-first, agent-intuitive interfaces).

---

## Active

| ID | Title | Summary |
|---|---|---|
| [BUG-016](bugs/BUG-016-bakeoff-incomplete-coverage-critical.md) | Bakeoff Failure — Incomplete Coverage vs Google Adapter — Agent-Reported | 5 bugs compounding. Initial: 18 of 36 receipts. Post-fix retest: 9 of 37 (worse). Core cause: FTS5 phrase-quote makes "apple.com" more restrictive than pre-fix workarounds; domain queries should route to `from:` filter not FTS phrase. Also: double-truncation in hybrid merge, `returned > totalMatched` impossibility, no exhaustive enumeration path for transactional queries. |
| [BUG-017](bugs/BUG-017-semantic-recall-gap-intent-queries.md) | Semantic Recall Gap for Intent-Based Queries — Agent-Reported | Bakeoff #2: zmail missed Marcio Nunes (Harmonee AI, Mar 3) despite data being in sync range. Evidence was spread across a Zoom invite, Otter.ai share, and investor intro — none contained the word "entrepreneur." Embedding mismatch + top-N truncation + no cross-email signal aggregation = recall failure for vague intent queries. **Bakeoff #5 confirmed resolution path:** FTS + agent query decomposition fixes this entirely. See OPP-019. |
| [BUG-018](bugs/BUG-018-who-timings-unknown-flag.md) | `zmail who --timings` Unknown Flag — Agent-Reported | CLI agent wasted a tool call (15-25s LLM round) attempting `zmail who --timings`, which fails with unknown flag. `zmail search --timings` works; `who` does not. Flag inconsistency across commands causes agent retry overhead. |

---

## Fixed (archived)

Fixed bugs are kept for context in [bugs/archive/](bugs/archive/).

| ID | Title | Summary |
|---|---|---|
| [BUG-001](bugs/archive/BUG-001-attachment-and-read-agent-friction.md) | Attachment and Read/Thread Friction — Agent-Reported | Read/thread ID handling, attachment read argument order, extract vs download (`--raw`), PDF in binary. Fixed (PDF via OPP-007; other items addressed or documented). |
| [BUG-002](bugs/archive/BUG-002-attachment-discoverability-and-read.md) | Attachment Discoverability and Read — Agent-Reported | Attachment subcommands (`attachment list`, `attachment read`) not discoverable from help; `read` doesn't show attachments; no path from "extracted: true" to content. Fixed: `read` now shows attachment summary with hints, attachment commands added to help. |
| [BUG-003](bugs/archive/BUG-003-fts-vs-semantic-search-guidance.md) | FTS vs Semantic Search Guidance — Agent-Reported | `--mode` flag exists but lacks discoverability and usage guidance. **Superseded by [OPP-008](opportunities/archive/OPP-008-simplify-search-modes.md)** — simplified interface by making hybrid default and removing mode selection complexity entirely. |
| [BUG-005](bugs/archive/BUG-005-xlsx-formula-cells-object-object.md) | XLSX Formula Cells Render as `[object Object]` — Agent-Reported | XLSX cells with formulas render as `[object Object]` instead of computed values; USD/totals lost in extracted CSV. Fixed: handle formula cell objects by extracting computed result from `result`, `value`, or `w` properties. |
| [BUG-006](bugs/archive/BUG-006-sync-repeated-connecting-message.md) | Sync Repeated "Connecting" Message in Non-TTY Mode — Agent-Reported | `zmail sync` printed "Connecting to IMAP server..." repeatedly in non-TTY mode. Fixed: guard with `process.stdout.isTTY`, print each status line only once in non-TTY. |
| [BUG-007](bugs/archive/BUG-007-sync-silent-auth-failure.md) | Sync Silent Authentication Failure — Agent-Reported | `zmail sync` reported success (exit 0) with invalid credentials; background sync crashed silently during IMAP auth, no error surfaced. Fixed: explicit error logging, log checking before success message, warnings for 0 messages. |
| [BUG-009](bugs/archive/BUG-009-wizard-crash-non-interactive.md) | `zmail wizard` Crashes with Stack Trace on Non-Interactive Stdin — Agent-Reported | `zmail wizard` crashed with unhandled `ExitPromptError` and full stack trace when run in non-TTY mode. Fixed: added TTY check at start of wizard function, exits gracefully with clear error message. |
| [BUG-004](bugs/archive/BUG-004-attachment-read-silent-failure.md) | Attachment Read Silent Failure — Agent-Reported | `zmail attachment read` fails silently (exit 1, no output) when given invalid index (e.g. 0). Help text doesn't clarify 0-based vs 1-based. Fixed (Verified 2026-03-07): Clear error message indicates 1-based indexing and valid range. |
| [BUG-008](bugs/archive/BUG-008-who-case-sensitive-email-dedup.md) | `zmail who` Case-Sensitive Email Deduplication — Agent-Reported | `zmail who` treats email addresses as case-sensitive, creating duplicate entries for the same person when addresses appear in different cases. Fixed (Verified 2026-03-07): All addresses normalized to lowercase, no more case-variant duplicates. |
| [BUG-010](bugs/archive/BUG-010-sync-backward-resume-skips-date-range.md) | Sync Backward Resume Skips Requested Date Range — Agent-Reported | `zmail sync --since 90d` after a 7-day sync silently skips the older date range; backward resume uses `oldestSynced` instead of `requestedSince` as the IMAP SEARCH boundary. Fixed: use `fromDate` (requested date) instead of `oldestDateStr` when expanding sync range. |
| [BUG-011](bugs/archive/BUG-011-who-dartmouth-not-merged.md) | `lewis.cirne@alum.dartmouth.org` Not Merged with Lewis Cirne Identity — Agent-Reported | Identity merger misses addresses with local-part variations (dots, underscores) when no display name exists. Fixed (Verified 2026-03-07): Name inference and fuzzy local-part matching enable merging of dot/underscore variants. |
| [BUG-012](bugs/archive/BUG-012-who-min-sent-splits-identity.md) | `--min-sent` Filter Splits Merged Identities — Agent-Reported | Filters apply before identity merging, causing merged identities to be split when individual addresses fall below threshold. Fixed (Verified 2026-03-07): Filters now apply after merging and aggregation. |
| [BUG-013](bugs/archive/BUG-013-who-noreply-display-name-leaks.md) | Noreply Addresses Leak Through Filter When Display Name Matches Query — Agent-Reported | Noreply addresses with matching display names bypass the noreply filter, appearing in results without `--all`. Fixed (Verified 2026-03-07): Noreply filter checks both addresses and display name patterns. |
| [BUG-014](bugs/archive/BUG-014-who-signature-parser-noise.md) | Signature Parser Extracts Footer Boilerplate as Title/Company — Agent-Reported | Signature parser extracts copyright notices, mailing addresses, and tracking URLs as contact information. Fixed (Verified 2026-03-07): Boilerplate filtering and noreply address skipping implemented. Additional improvements: standalone company name extraction, quoted reply detection, better signature selection (verified 2026-03-07). |
| [BUG-015](bugs/archive/BUG-015-who-name-inference-noreply-garbage.md) | Name Inference Produces Garbled `aka` Values for Noreply Addresses — Agent-Reported | Name inference runs on noreply addresses, producing garbled names like "Mess Ages-noreply" from `messages-noreply@linkedin.com`. Fixed (Verified 2026-03-07): Name inference skipped for noreply/bot addresses. |
