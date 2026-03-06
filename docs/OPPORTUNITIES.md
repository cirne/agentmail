# Product Opportunities

Improvement ideas discovered through real usage. Each entry captures the problem, a concrete example, and a proposed direction.

See [VISION.md](./VISION.md) for product vision, [ARCHITECTURE.md](./ARCHITECTURE.md) for technical decisions.

---

## Active opportunities

| ID | Title | Summary |
|---|---|---|
| [OPP-001](opportunities/OPP-001-personalization.md) | Personalization — User Context for Search | Let users define aliases and context so queries like "ranch" match emails that use project names like "Son Story." |
| [OPP-002](opportunities/OPP-002-local-embeddings.md) | Local Embeddings — Eliminate Search Latency and OpenAI Dependency | Replace OpenAI API embeddings with a local `bge-small-en-v1.5` model via transformers.js. Cuts search latency, removes the `OPENAI_API_KEY` requirement. |
| [OPP-006](opportunities/OPP-006-attachment-search-and-caching.md) | Attachment Search and Sibling-File Caching | FTS5 indexing of attachment content so search matches inside PDFs/docs; sibling-file caching for faster reads; additional format support (PPTX, images via vision). Extraction is shipped — these are next steps. |

---

## Implemented (archived)

Implemented opportunities are kept for context and moved to [opportunities/archive/](opportunities/archive/).

| ID | Title | Summary |
|---|---|---|
| [OPP-003](opportunities/archive/OPP-003-cli-search-interface.md) | CLI Search Interface — Header-First Results + Selective Hydration | Header-first defaults, mode controls (`auto|fts|semantic|hybrid`), payload-safe pagination, shortlist→hydrate retrieval. Core delivered; cursor pagination and provider labels remain optional. **Note:** Mode selection was simplified in [OPP-008](opportunities/archive/OPP-008-simplify-search-modes.md). |
| [OPP-008](opportunities/archive/OPP-008-simplify-search-modes.md) | Simplify Search Modes — Make Hybrid Default, Remove Mode Flag | Make hybrid (semantic + FTS) the default, remove `--mode` flag complexity, add simple `--fts` opt-out. Zero cognitive load — search just works. Implemented 2026-03-06. |
| [OPP-005](opportunities/archive/OPP-005-onboarding-claude-code.md) | Onboarding Workflow — Claude Code and OpenClaw | Help/setup without env, canonical onboarding text, auto-onboarding on missing config, `zmail setup`, install via `npm i -g @cirne/zmail` and `npm run install-cli` wrapper. llms.txt and stable release URL (npm) delivered via OPP-007. |
| [OPP-007](opportunities/OPP-007-packaging-npm-homebrew.md) | Packaging and Distribution — npm, Homebrew | Node.js 20+ runtime; install via `npm install -g @cirne/zmail`; dev uses `tsx`. Binary dropped; distribution via public npm. |
