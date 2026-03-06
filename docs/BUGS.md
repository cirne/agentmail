# Bugs — Agent and User Reports

When an agent or user hits a failure, we document it here. Root cause and "agent-intuitive" implications matter: **is the CLI intuitive enough for the LLM?** See [VISION.md](./VISION.md) (agent-first, agent-intuitive interfaces).

---

## Active

| ID | Title | Summary |
|---|---|---|
| [BUG-003](bugs/BUG-003-fts-vs-semantic-search-guidance.md) | FTS vs Semantic Search Guidance — Agent-Reported | `--mode` flag exists but lacks discoverability and usage guidance; no help text on when to use FTS vs semantic; no result attribution showing which search matched. |

---

## Fixed (archived)

Fixed bugs are kept for context in [bugs/archive/](bugs/archive/).

| ID | Title | Summary |
|---|---|---|
| [BUG-001](bugs/archive/BUG-001-attachment-and-read-agent-friction.md) | Attachment and Read/Thread Friction — Agent-Reported | Read/thread ID handling, attachment read argument order, extract vs download (`--raw`), PDF in binary. Fixed (PDF via OPP-007; other items addressed or documented). |
| [BUG-002](bugs/archive/BUG-002-attachment-discoverability-and-read.md) | Attachment Discoverability and Read — Agent-Reported | Attachment subcommands (`attachment list`, `attachment read`) not discoverable from help; `read` doesn't show attachments; no path from "extracted: true" to content. Fixed: `read` now shows attachment summary with hints, attachment commands added to help. |
