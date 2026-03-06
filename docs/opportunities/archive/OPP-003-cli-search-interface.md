# OPP-003: CLI Search Interface — Header-First Results + Selective Hydration

**Status: Implemented (archived).** Core deliverables are in place; optional work (cursor pagination, provider labels) remains.

**Note:** Mode selection was simplified in [OPP-008](OPP-008-simplify-search-modes.md) — hybrid is now the default, with `--fts` flag for FTS-only search. The `--mode` flag has been removed.

**Problem:** The current CLI search interface is optimized for "return rich snippets now" rather than "help an agent iterate quickly." In real agent workflows, this causes unnecessary latency, oversized payloads, and brittle post-processing.

Observed pain points:

- **Single fixed result shape:** Search always returns message metadata plus snippet, with no projection or detail controls.
- **Always-hybrid execution:** Search always runs FTS + semantic, even when a fast metadata/keyword pass is sufficient.
- **Large output fragility:** Broad searches with high limits can exceed output boundaries and return malformed JSON.
- **No first-class shortlist → hydrate flow:** The workflow exists conceptually (`search` then `message`/`thread`), but search output is not tuned for fast shortlist creation.

**Example (real cloud run):**

- Hybrid query latency (`zmail search "opening eye in bedding calls" --json`) was ~588ms p50.
- Filter-only query latency (`zmail search "from:hello@theinformation.com" --json`) was ~233ms p50.
- A broad search (`receipt`, `--limit 200`) produced truncated output and invalid JSON at 65,536 bytes.

This gap shows that many agent tasks are paying hybrid + payload costs when they only need headers first.

## Proposed direction

Make the CLI explicitly support a two-step agent retrieval pattern:

1. **Find candidates fast** (header-first, smaller payload, lower latency)
2. **Hydrate selected messages** only when needed

### 1) Header-first defaults

Add search detail controls:

- `--detail headers|snippet|body`
- Default to `headers`

Default `headers` payload should include only:

- `messageId`, `threadId`, `date`, `fromAddress`, `fromName`, `subject`, `rank` (and optional tiny `preview`)

### 2) Query mode controls

Add:

- `--mode auto|fts|semantic|hybrid`

`auto` should choose fast path when query/filter intent is clearly lexical or metadata-driven (sender/date/ID), and choose hybrid when semantic retrieval is likely beneficial.

### 3) Field projection + payload safety

Add:

- `--fields` for explicit projection (`messageId,threadId,date,fromAddress,subject`)
- `--cursor` pagination (in addition to offset)
- output byte cap and explicit `truncated` indicator when limits are hit
- stricter `--limit` bounds for JSON mode

### 4) First-class hydration ergonomics

Keep `zmail message <id>` and `zmail thread <id>` as follow-up calls, but align search output to make this easy:

- always include stable IDs
- optionally include `--ids-only` for ultra-cheap shortlist generation

### 5) Built-in timings for tuning

Add:

- `--timings` to print machine-readable stage timings (fts_ms, embed_ms, vector_ms, merge_ms, total_ms, mode_used)

This helps agent planners choose faster modes dynamically.

### 6) Reuse provider-native labels before inventing new taxonomy

For category-oriented workflows (e.g., `invoice`, `delivery`, `travel`, `news`), treat existing provider metadata as the first signal:

- Gmail labels/tags (via `X-GM-LABELS`)
- folder/system labels (Inbox, Sent, Promotions, etc.)

Then add a normalized category layer as **additive metadata**, not a replacement for provider labels:

- preserve original labels for fidelity and portability
- map provider labels/terms into canonical categories where possible
- allow classifier- or rule-derived categories when no provider label exists

This keeps the first iteration lightweight while preserving a path to cross-provider category search.

## Implementation status (delivered)

Completed:

- ✅ `SearchOptions` + CLI parser now support `--detail`, `--mode`, `--fields`, `--timings`.
- ✅ Search execution supports `auto|fts|semantic|hybrid` (instead of always-hybrid).
- ✅ Default detail is header-first (`headers`) with stable IDs in output.
- ✅ Output shaping supports header/snippet/body detail levels.
- ✅ `--ids-only` supports ultra-cheap shortlist generation.
- ✅ JSON payload safety now includes byte-capped serialization with explicit `truncated` metadata.
- ✅ JSON mode applies stricter `--limit` bounds (caps large limits for output stability).
- ✅ Built-in timings are emitted with machine-readable stage fields (`ftsMs`, `embedMs`, `vectorMs`, `mergeMs`, `totalMs`, `modeUsed`).

Remaining (optional):

- ⏳ `--cursor` pagination contract is not implemented yet.
- ⏳ Provider-native label/category workflows are not yet exposed in CLI search filters.
- ⏳ A dedicated CLI reference page (beyond README snippets) is not yet published.

## What stays the same

- SQLite FTS5 + LanceDB hybrid architecture
- Existing `search`, `message`, and `thread` command surfaces
- RRF ranking logic for hybrid mode
