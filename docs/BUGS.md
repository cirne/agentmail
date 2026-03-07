# Bugs — Agent and User Reports

When an agent or user hits a failure, we document it here. Root cause and "agent-intuitive" implications matter: **is the CLI intuitive enough for the LLM?** See [VISION.md](./VISION.md) (agent-first, agent-intuitive interfaces).

---

## Active

| ID | Title | Summary |
|---|---|---|
| [BUG-004](bugs/BUG-004-attachment-read-silent-failure.md) | Attachment Read Silent Failure — Agent-Reported | `zmail attachment read` fails silently (exit 1, no output) when given invalid index (e.g. 0). Help text doesn't clarify 0-based vs 1-based. |
| [BUG-005](bugs/BUG-005-xlsx-formula-cells-object-object.md) | XLSX Formula Cells Render as `[object Object]` — Agent-Reported | XLSX cells with formulas render as `[object Object]` instead of computed values; USD/totals lost in extracted CSV. |

---

## Fixed (archived)

Fixed bugs are kept for context in [bugs/archive/](bugs/archive/).

| ID | Title | Summary |
|---|---|---|
| [BUG-001](bugs/archive/BUG-001-attachment-and-read-agent-friction.md) | Attachment and Read/Thread Friction — Agent-Reported | Read/thread ID handling, attachment read argument order, extract vs download (`--raw`), PDF in binary. Fixed (PDF via OPP-007; other items addressed or documented). |
| [BUG-002](bugs/archive/BUG-002-attachment-discoverability-and-read.md) | Attachment Discoverability and Read — Agent-Reported | Attachment subcommands (`attachment list`, `attachment read`) not discoverable from help; `read` doesn't show attachments; no path from "extracted: true" to content. Fixed: `read` now shows attachment summary with hints, attachment commands added to help. |
| [BUG-003](bugs/archive/BUG-003-fts-vs-semantic-search-guidance.md) | FTS vs Semantic Search Guidance — Agent-Reported | `--mode` flag exists but lacks discoverability and usage guidance. **Superseded by [OPP-008](opportunities/archive/OPP-008-simplify-search-modes.md)** — simplified interface by making hybrid default and removing mode selection complexity entirely. |
