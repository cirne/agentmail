# BUG-003: FTS vs Semantic Search Guidance — Agent-Reported

**Status:** Superseded by [OPP-008](../opportunities/archive/OPP-008-simplify-search-modes.md)

**Note:** This bug was originally fixed by adding help text and hints for mode selection. However, [OPP-008](../opportunities/archive/OPP-008-simplify-search-modes.md) provided a better solution by simplifying the interface entirely — making hybrid the default and removing mode selection complexity. The original fix is now obsolete.

**Design lens:** [Agent-first](../../VISION.md) — agents need clear guidance on when to use FTS vs semantic search. The `--mode` flag exists (OPP-003) but lacks discoverability and usage guidance, leading to suboptimal search choices and frustration.

**Reported context:** Agent testing session 2026-03-06; discovered that while `--mode auto|fts|semantic|hybrid` exists, there's no guidance on when to use each mode, no help text explaining trade-offs, and no result attribution showing which search type matched.

---

## Summary

Users (especially agents) don't know when to use full-text search (FTS) vs semantic search. While the CLI supports `--mode auto|fts|semantic|hybrid` (implemented in OPP-003), there's no guidance on which mode is better for a given query type. This leads to:
- Suboptimal search performance (wrong tool for the job)
- Frustration when semantic searches return empty results
- Unpredictable behavior from agent perspective
- Missed search opportunities where semantic would excel

Results include a `rank` field, but semantics are unclear to end users. No indication of whether a match came from FTS or semantic. No guidance on query types that work better with each.

---

## What the agent did (and what happened)

**Testing results from feedback:**

### ✅ Semantic Search Excels At:
- **Concept matching**: Query "flying vehicles" → hits "Electric Air Taxis" (exact keyword not present)
- **Domain topics**: "battery technology startups" → finds related battery startup articles
- **Health/science concepts**: "vaccine side effects" → matches COVID vaccine impact article
- **Equipment/product categories**: "putting golf" → finds putter articles

### ❌ Semantic Search Struggles With:
- **Abstract actions**: "moving funds between banks" → no results (too conceptual)
- **Multi-concept queries**: "electric transport Trump" → no results (too specific combination)
- **Precise/literal lookups**: Better handled by FTS

### ✅ FTS is Best For:
- Exact phrases: "Son Story project updates"
- Proper nouns: People names, company names
- Specific keywords: Technical terms, IDs
- Boolean logic combinations

**Current behavior:**
```bash
zmail search "query"  # Runs both FTS + semantic, combines results
                      # User has no control or understanding of which is working
```

---

## Root causes

### 1. `--mode` flag exists but lacks discoverability

- **Current state:** `--mode auto|fts|semantic|hybrid` was implemented in OPP-003, but it's not mentioned in `zmail search --help`
- **Agent impact:** Agents don't know the flag exists; they can't make informed choices about search strategy
- **Gap:** Technical capability exists but is invisible to users/agents

### 2. No guidance on when to use each mode

- **Current behavior:** No help text explaining trade-offs between FTS and semantic search
- **Agent expectation:** Agents need to understand query characteristics that favor each approach
- **Gap:** No documentation or hints about query patterns (proper nouns → FTS, concepts → semantic)

### 3. No result attribution

- **Current behavior:** Results include `rank` but no indication of which search type matched (`matched_by`, `match_type`)
- **Agent impact:** Agents can't learn which search strategy worked for a given query
- **Gap:** No feedback loop to improve search strategy selection

### 4. No agent-specific guidance in documentation

- **Current behavior:** No search strategy guide in CLAUDE.md or AGENTS.md
- **Agent impact:** Agents must guess or trial-and-error to determine search approach
- **Gap:** Documentation doesn't help agents make informed search decisions

---

## Recommendations (concise)

1. **Help text:** Add search mode guidance to `zmail search --help`: ✅ **FIXED**
   - Added detailed "Search modes" section to `zmail search --help` with examples
   - Updated main `zmail --help` to hint at search modes

2. **Smart auto mode:** Enhance `--mode auto` with heuristics: ⏸️ **DEFERRED**
   - Auto mode already exists with basic heuristics
   - Enhanced heuristics can be added as future improvement

3. **Result attribution:** Add mode information to search results: ✅ **FIXED**
   - Added `modeUsed` field to JSON output (always included)
   - Added `hint` field to JSON output suggesting alternative modes
   - Added contextual hints in TTY output showing mode used and alternatives

4. **Documentation:** Add search strategy guide to AGENTS.md: ✅ **FIXED**
   - Added comprehensive "Search strategy" section to AGENTS.md
   - Includes when to use each mode with examples

5. **Default behavior:** `--mode auto` is the default ✅ **CONFIRMED**
   - Auto mode is already the default
   - Clear documentation added to help text and AGENTS.md

## Implementation Summary

**Fixed 2026-03-06:**
- Enhanced `zmail search --help` with detailed mode guidance and examples
- Added search strategy section to AGENTS.md
- Added `modeUsed` field to all JSON search responses
- Added `hint` field to JSON output suggesting alternative modes
- Added contextual hints in TTY output (shows mode used + alternatives)
- Updated main `zmail --help` to hint at search modes

**Remaining:**
- Enhanced auto mode heuristics (optional future improvement)

---

## References

- Vision (agent-first): [VISION.md](../../VISION.md)
- Related: [OPP-003 (CLI search interface)](../opportunities/archive/OPP-003-cli-search-interface.md) — implemented `--mode` flag but didn't address guidance/discoverability
- CLI search usage: `zmail search "query" [--mode auto|fts|semantic|hybrid]` (see [AGENTS.md](../../AGENTS.md))
