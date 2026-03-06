# OPP-008: Simplify Search Modes — Make Hybrid Default, Remove Mode Flag

**Status:** Implemented (2026-03-06)

**Problem:** The current `--mode` flag (`fts`, `semantic`, `hybrid`) forces callers to understand search internals. Agents don't know which mode to pick and default to FTS, missing semantic matches. The hint system teaches the wrong lesson — users shouldn't need to think about modes. There's no scenario where `--mode semantic` alone is better than hybrid (hybrid includes semantic). "Hybrid" is implementation jargon, not a user concept.

**Example:** Testing showed that every query that used hybrid got better or equal results vs FTS-only:
- `"meetings this week"` — Natural language query got keyword search (FTS) with poor results; hybrid would have worked better
- `"what did kirsten say about the trip"` — Hybrid worked well; this should be the default
- `"emails about travel plans or flights"` — Hybrid worked well with good relevance
- `"receipts"` — Exact keyword, FTS was fine, but hybrid would have been equally fine

Key finding: **every query that used hybrid got better or equal results vs FTS-only.** No downside observed.

**Proposed direction:** Simplify the interface by removing mode complexity:

1. **Make hybrid the default** — always run semantic + FTS together
2. **Remove `--mode` flag entirely** — replace with a single opt-out flag
3. **Add `--fts` flag** — for when callers want exact keyword matching only

### New interface

```bash
zmail search "query"         # Always runs semantic + FTS (current "hybrid")
zmail search "query" --fts   # FTS only, for exact keyword matching
```

No `--mode`, no `hybrid`, no `semantic`. Just "search" and "search --fts".

### New hint strategy

Drop the mode-switching hint. Replace with actionable hints:

| Condition | Hint |
|-----------|------|
| 0 results | `"No results found. Try broader terms or check spelling."` |
| Truncated results | `"Showing 20 of 85 matches. Use --limit to see more."` |
| Vague single-word query | `"Tip: Narrow results with from:name or subject:keyword"` |
| Query has exact keyword feel | `"Tip: Add --fts for exact keyword matching"` |

**Benefits:**
- Zero cognitive load — search just works
- Agents never pick the wrong mode (there's only one mode)
- Simpler CLI interface, fewer flags to document
- Hint system focuses on genuinely useful guidance instead of mode education
- No performance penalty (hybrid cost is near-zero)

**Agent-Friendliness Impact:**

This is a major win for agents. Currently an agent has to:
1. Guess which mode to use
2. Parse the hint suggesting a different mode
3. Re-run the search with the suggested mode
4. Compare results

With this change: just search. One call, best results. The `--fts` escape hatch exists but agents will rarely need it.

## Implementation Impact

This change requires updates across multiple areas of the codebase and documentation:

### Code Changes

**CLI (`src/cli/index.ts`):**
- Remove `--mode` flag parsing and validation
- Add `--fts` flag parsing (boolean flag)
- Update `parseSearchArgs()` to remove mode handling, add `fts: boolean` field
- Remove `VALID_MODES` constant
- Update `searchUsage()` help text — remove mode documentation, add `--fts` flag
- Remove `getModeHint()` function (mode-switching hints)
- Update `serializeJsonPayload()` — remove `modeUsed` parameter (or keep for backwards compat?)
- Remove `modeUsed` from JSON output (or change to always "hybrid" except when `--fts`)
- Remove mode hints from TTY output
- Update main CLI help (`CLI_USAGE` in `src/lib/onboarding.ts`) — remove mode hint
- Update default search behavior — always use hybrid unless `--fts` is set

**Search (`src/search/index.ts`):**
- Update `SearchOptions` interface — remove `mode?: SearchMode`, add `fts?: boolean`
- Remove `SearchMode` type (or keep for backwards compat?)
- Update `resolveMode()` — remove mode resolution logic, always return "hybrid" unless `fts: true`
- Simplify `searchWithMeta()` — remove mode branching, always run hybrid unless `fts: true`
- Update `SearchResultSet` — remove `modeUsed` field (or always return "hybrid")
- Update `SearchTimings` — no changes needed (already doesn't include modeUsed)

**MCP Server (`src/mcp/index.ts`):**
- Update `search_mail` tool description — remove mode references, mention hybrid is default
- Add `fts` parameter to `search_mail` tool (optional boolean)
- Update tool documentation in `docs/MCP.md`

**Tests (`src/search/search.test.ts`):**
- Update tests that use `mode: "auto"` or other modes
- Add tests for `--fts` flag behavior
- Remove mode-specific test cases

### Documentation Changes

**AGENTS.md:**
- Remove entire "Search strategy" section (lines 119-150)
- Replace with simple note: "Search uses hybrid (semantic + FTS) by default. Use `--fts` for exact keyword matching only."

**docs/MCP.md:**
- Update `search_mail` tool description — remove mode references
- Add `fts` parameter documentation
- Update examples to remove mode references

**docs/ARCHITECTURE.md:**
- Update ADR-005 or search-related sections — remove mode selection discussion
- Update to reflect hybrid-as-default architecture

**docs/bugs/archive/BUG-003-fts-vs-semantic-search-guidance.md:**
- Add note that this bug was superseded by OPP-008 (simpler solution)

**docs/opportunities/archive/OPP-003-cli-search-interface.md:**
- Add note that mode selection was simplified in OPP-008

**docs/EXA.md:**
- Update example that uses `--mode=enriched` (if still relevant)

### Output Changes

**JSON Output:**
- Remove `modeUsed` field (or always return "hybrid")
- Remove `hint` field that suggests mode switching
- Add new hints based on query characteristics (see "New hint strategy" above)

**TTY Output:**
- Remove mode hints (`[Mode: fts] Try --mode semantic or hybrid`)
- Remove mode tips on no results (`Tip: Used FTS mode. Try --mode semantic or hybrid`)
- Add new actionable hints (see "New hint strategy" above)

**Help Text:**
- `zmail search --help`: Remove "Search modes" section, add `--fts` flag
- `zmail --help`: Remove mode hint, update search command description

### Backwards Compatibility Considerations

**Deprecation Strategy:**
- Option 1: Remove `--mode` immediately (breaking change)
- Option 2: Keep `--mode` but deprecate it, map to new interface:
  - `--mode hybrid` → default behavior (no flag)
  - `--mode fts` → `--fts` flag
  - `--mode semantic` → default behavior (hybrid includes semantic)
  - `--mode auto` → default behavior
- Option 3: Support both `--mode` and `--fts` during transition period

**Migration Path:**
- If keeping backwards compat, add deprecation warnings when `--mode` is used
- Document migration guide for agents/scripts using `--mode`

**Open questions:**
- Should we deprecate `--mode` gradually or remove it immediately?
- Do we need backwards compatibility for existing scripts/agents using `--mode`?
- Should `--fts` be documented as "exact keyword matching" or "full-text search only"?
- Should we keep `modeUsed` in JSON output (always "hybrid") for debugging/monitoring?

**References:**
- Related: [BUG-003](bugs/archive/BUG-003-fts-vs-semantic-search-guidance.md) — addressed discoverability but this proposes removing the complexity entirely
- Supersedes earlier feedback in `submitted/ux-semantic-search-guidance.md` which recommended adding flags and auto-detection heuristics — simpler answer is to always do both
