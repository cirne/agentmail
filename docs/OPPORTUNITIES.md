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
| [OPP-016](opportunities/OPP-016-multi-inbox.md) | Multi-Inbox — One Install, Home + Work | Single install supports multiple mailboxes (e.g. home + work). One unified SQLite DB, single config.json (config only), root .env + per-mailbox .env; sync/refresh all by default with optional --mailbox to narrow; optional inbox: query operator. |
| [OPP-017](opportunities/OPP-017-code-health-idiomatic-patterns.md) | Code Health Sprint — Simplify, Reuse, and Idiomatic Patterns | Prioritized code-health refactors: atomic process locks, shared sync/index orchestration, CLI modularization, explicit config loading, sync/rebuild reuse, MCP/CLI boundary cleanup, and consistent search filter semantics. |
| [OPP-018](opportunities/OPP-018-reduce-agent-round-trips.md) | Reduce Agent Round-Trips — Richer Search Output + Batch Reads | LLM thinking is 91–99% of wall-clock; each tool call round costs 15–25s. Target: 3–4 rounds → 1–2. Interventions: body preview (200-300 chars) in every search result; MCP `get_messages` batch call (5 sequential → 1); attachment indicators in search results; newsletter detection for denser inline content. Expected: 99s → ~45s for tech news query; closes/beats Gmail 74s gap. |
| [OPP-019](opportunities/OPP-019-fts-first-retire-semantic-default.md) | FTS-First Architecture — Retire Semantic Search as Default | **Strategic pivot confirmed by empirical testing.** Disabling vector search improved wall-clock time AND answer quality across all bakeoff scenarios. The agent IS the semantic layer — it decomposes vague queries into keywords, making zmail's embedding search redundant. FTS is 10-100x faster, guarantees recall, and agents adapt naturally. Bakeoff #5: FTS-only zmail MCP beat Gmail on the query that semantic search had failed (#2). Resolves BUG-017, simplifies BUG-016 fix, reduces priority of OPP-002, can eliminate LanceDB dependency. |
| [OPP-020](opportunities/OPP-020-answer-engine-local-agent.md) | Answer Engine — Local Agent for 10x Faster Email Queries | **Architectural experiment.** Instead of exposing tool primitives for an external LLM to orchestrate (3-4 rounds × 15-25s each = 60-100s), zmail becomes a single-call answer engine: `zmail ask "summarize tech news"` runs intent classification → FTS search → fast-model synthesis internally in 2-5s. Standalone CLI bypasses the outer LLM entirely; MCP `ask_email` tool reduces to 1 round (~15-20s). 5-20x improvement over current architecture. |
| [OPP-021](opportunities/OPP-021-ask-spam-promo-awareness.md) | Ask / Search — Spam and Promotional Signal Awareness | Use spam/promotional indicators (labels, List-* headers, precedence) so ask and search favor personal/transactional mail. E.g. "travel" → real confirmations over marketing; "what's most recent" → recent items that pass a promotional filter. Start with filter (simpler) rather than ranking. |
| [OPP-023](opportunities/OPP-023-ask-only-interface.md) | Ask-Only Interface — Remove Search/Read/Thread/Who Primitives | Remove 6 CLI commands and 7 MCP tools in favor of `ask` / `ask_email` as the sole query interface. Cuts surface area ~50%, eliminates BUG-018/021-class bugs, forces `ask` quality investment. Phased: add `ask_email` MCP tool → deprecate → remove. Prerequisite: OPP-022 (implemented). |

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
| [OPP-022](opportunities/archive/OPP-022-ask-synthesis-detail-level.md) | Ask Synthesis — Default Detail Level Too Shallow for Broad Queries | Replaced "Be concise" with adaptive prompt: concise for lookups, thorough for broad synthesis. Eval scores maintained or improved across all cases. Implemented 2026-03-09. |
| [OPP-024](opportunities/archive/OPP-024-sqlite-node-abi-mitigation.md) | SQLite / Node ABI — Global Install Reliability | `postinstall` rebuilds `better-sqlite3` for the current Node; async `SqliteDatabase` facade over the native driver; ADR-023. Reduces `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` mismatches on `npm i -g`. Implemented 2026-03-20. |
