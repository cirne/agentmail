# Product Opportunities

Improvement ideas discovered through real usage. Each entry captures the problem, a concrete example, and a proposed direction.

See [VISION.md](./VISION.md) for product vision, [ARCHITECTURE.md](./ARCHITECTURE.md) for technical decisions.

**Strategic sequencing:** Send (draft + SMTP) is in the vision. Send is blocked on customer validation for core search/index/onboarding — we want to nail that first. See [OPP-011](opportunities/OPP-011-send-email.md).

---

## Active opportunities

| ID | Title | Summary |
|---|---|---|
| [OPP-001](opportunities/OPP-001-personalization.md) | Personalization — User Context for Search | Let users define aliases and context so queries like "ranch" match emails that use project names like "Son Story." |
| [OPP-002](opportunities/OPP-002-local-embeddings.md) | Local Embeddings — Eliminate Search Latency and OpenAI Dependency | Replace OpenAI API embeddings with a local `bge-small-en-v1.5` model via transformers.js. Cuts search latency, removes the `OPENAI_API_KEY` requirement. |
| [OPP-006](opportunities/OPP-006-attachment-search-and-caching.md) | Attachment Search and Sibling-File Caching | FTS5 indexing of attachment content so search matches inside PDFs/docs; sibling-file caching for faster reads; additional format support (PPTX, images via vision). Extraction is shipped — these are next steps. |
| [OPP-010](opportunities/OPP-010-sync-performance.md) | Sync / Refresh Performance — 5x Faster | Achieved 5x faster "nothing new" refreshes (42s → 8.2s) via STATUS fast path, EXAMINE instead of SELECT, parallel connect, and batch optimizations. See [SYNC.md](./SYNC.md) for implementation details. |
| [OPP-011](opportunities/OPP-011-send-email.md) | Send Email — Draft + SMTP | Add send via SMTP (send-as-user). Draft + confirm, voice profile from history, tagline. **Blocked on customer validation for core search/index/onboarding.** |
| [OPP-012](opportunities/OPP-012-who-smart-address-book.md) | Make `zmail who` a Smart, Unified Address Book | Evolve `zmail who` into identity-aware contact graph: case-insensitive dedup, identity merging, signature extraction (phone/title/company), relationship scoring, noreply filtering. |
| [OPP-013](opportunities/OPP-013-who-name-inference-from-address.md) | Name Inference from Email Addresses | Infer display names from email addresses (e.g., `lewis.cirne@...` → "Lewis Cirne") as fallback when no header name exists. Enables identity merging for addresses without display names. |
| [OPP-014](opportunities/OPP-014-who-external-enrichment-exploration.md) | External Enrichment for `zmail who` — Exploration | Tested Exa API for LinkedIn/Twitter/GitHub enrichment via `--enrich` flag. Exa's `category: "people"` returns wrong profiles (matches by last name, not exact name). Alternatives evaluated: Tavily (promising), OpenAI (not ideal), free options (unreliable). |
| [OPP-015](opportunities/OPP-015-who-enhanced-signature-extraction.md) | Enhanced Signature Extraction for `zmail who` | Extract richer structured contact info from signatures: multiple phone numbers (mobile/office/fax), categorized URLs (LinkedIn/Twitter/GitHub), department/team, office location/timezone, pronouns, preferred name. Makes `who` a more complete address book. |

---

## Implemented (archived)

Implemented opportunities are kept for context and moved to [opportunities/archive/](opportunities/archive/).

| ID | Title | Summary |
|---|---|---|
| [OPP-003](opportunities/archive/OPP-003-cli-search-interface.md) | CLI Search Interface — Header-First Results + Selective Hydration | Header-first defaults, mode controls (`auto|fts|semantic|hybrid`), payload-safe pagination, shortlist→hydrate retrieval. Core delivered; cursor pagination and provider labels remain optional. **Note:** Mode selection was simplified in [OPP-008](opportunities/archive/OPP-008-simplify-search-modes.md). |
| [OPP-008](opportunities/archive/OPP-008-simplify-search-modes.md) | Simplify Search Modes — Make Hybrid Default, Remove Mode Flag | Make hybrid (semantic + FTS) the default, remove `--mode` flag complexity, add simple `--fts` opt-out. Zero cognitive load — search just works. Implemented 2026-03-06. |
| [OPP-005](opportunities/archive/OPP-005-onboarding-claude-code.md) | Onboarding Workflow — Claude Code and OpenClaw | Help/setup without env, canonical onboarding text, auto-onboarding on missing config, `zmail setup`, install via `npm i -g @cirne/zmail` and `npm run install-cli` wrapper. llms.txt and stable release URL (npm) delivered via OPP-007. |
| [OPP-007](opportunities/archive/OPP-007-packaging-npm-homebrew.md) | Packaging and Distribution — npm, Homebrew | Node.js 20+ runtime; install via `npm install -g @cirne/zmail`; dev uses `tsx`. Binary dropped; distribution via public npm. |
| [OPP-009](opportunities/archive/OPP-009-agent-friendly-setup.md) | Agent-Friendly Setup + Wizard | `zmail setup` via CLI flags/env (agent-first); `zmail wizard` with @inquirer/prompts for interactive. Implemented 2026-03-07. |
