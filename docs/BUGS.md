# Bugs — Agent and User Reports

When an agent or user hits a failure, we document it here. Root cause and "agent-intuitive" implications matter: **is the CLI intuitive enough for the LLM?** See [VISION.md](./VISION.md) (agent-first, agent-intuitive interfaces).

---

## Active

| ID | Title | Summary |
|---|---|---|
| [BUG-004](bugs/BUG-004-attachment-read-silent-failure.md) | Attachment Read Silent Failure — Agent-Reported | `zmail attachment read` fails silently (exit 1, no output) when given invalid index (e.g. 0). Help text doesn't clarify 0-based vs 1-based. |
| [BUG-005](bugs/BUG-005-xlsx-formula-cells-object-object.md) | XLSX Formula Cells Render as `[object Object]` — Agent-Reported | XLSX cells with formulas render as `[object Object]` instead of computed values; USD/totals lost in extracted CSV. |
| [BUG-006](bugs/BUG-006-sync-repeated-connecting-message.md) | Sync Repeated "Connecting" Message in Non-TTY Mode — Agent-Reported | `zmail sync` prints "Connecting to IMAP server..." 11 times concatenated in non-TTY mode due to missing TTY detection for cursor overwrite tricks. |
| [BUG-008](bugs/BUG-008-who-case-sensitive-email-dedup.md) | `zmail who` Case-Sensitive Email Deduplication — Agent-Reported | `zmail who` treats email addresses as case-sensitive, creating duplicate entries for the same person when addresses appear in different cases. |

---

## Fixed (archived)

Fixed bugs are kept for context in [bugs/archive/](bugs/archive/).

| ID | Title | Summary |
|---|---|---|
| [BUG-001](bugs/archive/BUG-001-attachment-and-read-agent-friction.md) | Attachment and Read/Thread Friction — Agent-Reported | Read/thread ID handling, attachment read argument order, extract vs download (`--raw`), PDF in binary. Fixed (PDF via OPP-007; other items addressed or documented). |
| [BUG-002](bugs/archive/BUG-002-attachment-discoverability-and-read.md) | Attachment Discoverability and Read — Agent-Reported | Attachment subcommands (`attachment list`, `attachment read`) not discoverable from help; `read` doesn't show attachments; no path from "extracted: true" to content. Fixed: `read` now shows attachment summary with hints, attachment commands added to help. |
| [BUG-003](bugs/archive/BUG-003-fts-vs-semantic-search-guidance.md) | FTS vs Semantic Search Guidance — Agent-Reported | `--mode` flag exists but lacks discoverability and usage guidance. **Superseded by [OPP-008](opportunities/archive/OPP-008-simplify-search-modes.md)** — simplified interface by making hybrid default and removing mode selection complexity entirely. |
| [BUG-007](bugs/archive/BUG-007-sync-silent-auth-failure.md) | Sync Silent Authentication Failure — Agent-Reported | `zmail sync` reported success (exit 0) with invalid credentials; background sync crashed silently during IMAP auth, no error surfaced. Fixed: explicit error logging, log checking before success message, warnings for 0 messages. |
| [BUG-009](bugs/archive/BUG-009-wizard-crash-non-interactive.md) | `zmail wizard` Crashes with Stack Trace on Non-Interactive Stdin — Agent-Reported | `zmail wizard` crashed with unhandled `ExitPromptError` and full stack trace when run in non-TTY mode. Fixed: added TTY check at start of wizard function, exits gracefully with clear error message. |
