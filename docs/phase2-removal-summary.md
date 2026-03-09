# Phase 2 Removal Summary

**Date:** 2026-03-09  
**Change:** Removed Phase 2 (context assembly) from `zmail ask` algorithm

---

## What Was Removed

### Code Removed (~150 lines)

1. **Phase 2 Loop** (`src/ask/agent.ts`)
   - Context assembly LLM round
   - `add_message` / `add_attachment` tool calls
   - Phase 2 system prompts and messages
   - Context set state management

2. **Phase 2 Tools** (`src/ask/tools.ts`)
   - `executeAddMessageTool()` function
   - `executeAddAttachmentTool()` function
   - `getContextAssemblyToolDefinitions()` function
   - `add_message` and `add_attachment` tool definitions

3. **CLI Flag** (`src/cli/index.ts`)
   - `--skip-phase2` flag parsing and handling

4. **Interfaces** (`src/ask/agent.ts`)
   - `ContextSet` interface (no longer needed)

5. **Test Files**
   - `scripts/compare-phase2.sh` (comparison script)
   - `docs/phase2-comparison-test.md` (testing guide)

---

## What Changed

### Algorithm Flow

**Before (3 phases):**
```
Phase 1: Investigation (Nano) → finds candidates
Phase 2: Context Assembly (Nano) → filters candidates
Context Assembler → fetches full content
Phase 3: Mini Synthesis → generates answer
```

**After (2 phases):**
```
Phase 1: Investigation (Nano) → finds candidates
Context Assembler → fetches full content from ALL candidates
Phase 2: Mini Synthesis → generates answer
```

### Key Changes

1. **Direct candidate usage:** Phase 1 candidates are now used directly for context assembly (no filtering)
2. **Simplified state:** Removed `ContextSet` and Phase 2 state management
3. **Faster:** Eliminates 1-2 LLM rounds (200-500ms each)
4. **Better quality:** Uses all relevant candidates instead of filtering

---

## Benefits

1. **Improved Answer Quality**
   - Uses all Phase 1 candidates (no over-filtering)
   - More complete information in answers
   - Better recall for queries requiring comprehensive coverage

2. **Reduced Latency**
   - Eliminates Phase 2 LLM rounds (1-2 seconds saved)
   - Simpler pipeline = faster execution

3. **Simplified Code**
   - ~150 lines removed
   - One less state machine to maintain
   - Fewer edge cases and failure modes

4. **Lower Cost**
   - Fewer LLM API calls per query
   - No Phase 2 tool calls

---

## Evidence

See `docs/phase2-comparison-results.md` for detailed test results showing:
- 3 of 4 queries produced better answers without Phase 2
- Average 1-2 second latency reduction
- Phase 2 consistently filtered out relevant messages

---

## Migration Notes

- **No breaking changes:** CLI interface unchanged (except removed `--skip-phase2` flag)
- **Backward compatible:** Existing queries work the same, just faster and better
- **Documentation:** `docs/ASK.md` should be updated to reflect simplified pipeline

---

## Files Modified

- `src/ask/agent.ts` - Removed Phase 2 loop, simplified pipeline
- `src/ask/tools.ts` - Removed Phase 2 tools
- `src/cli/index.ts` - Removed `--skip-phase2` flag

## Files Deleted

- `scripts/compare-phase2.sh`
- `docs/phase2-comparison-test.md`

## Files Created

- `docs/phase2-comparison-results.md` - Test results and analysis
- `docs/phase2-removal-summary.md` - This file
