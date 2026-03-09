# `zmail ask` Algorithm Review

**Date:** 2026-03-09  
**Reviewer:** AI Code Review  
**Scope:** Coherence, complexity, tech debt analysis

---

## Executive Summary

The `ask` algorithm implements a **two-phase Nano → Context Assembler → Mini** pipeline that achieves 4-10x latency improvement over primitive tool orchestration. However, it suffers from **significant complexity** and **architectural inconsistencies** that create maintenance burden and potential failure modes.

**Key Findings:**
- ✅ **Core concept is sound:** Fast exploration → curated context → synthesis
- ⚠️ **Phase 2 (context assembly) is redundant** — Nano already collected candidates in Phase 1
- ⚠️ **Complex state tracking** — 7+ state variables with interdependent logic
- ⚠️ **Over-engineered auto-injection** — Complex `fromAddress` injection logic that's hard to reason about
- ⚠️ **Massive system prompts** — 280+ lines of rules that could be simplified
- ⚠️ **Inconsistent error handling** — Silent JSON parse failures scattered throughout

---

## Architecture Overview

```
User Question
    ↓
Phase 1: Investigation (Nano)
    ├─ Search/who/get_message (metadata only)
    ├─ Collects candidateMessageIds + candidateAttachmentIds
    └─ Output: "investigation complete"
    ↓
Phase 2: Context Assembly (Nano)
    ├─ Receives candidate IDs from Phase 1
    ├─ Calls add_message/add_attachment to build contextSet
    └─ Output: "context assembly complete"
    ↓
Context Assembler (Pure Code)
    ├─ Fetches full bodies + attachments
    ├─ Applies content caps
    └─ Output: formatted context string
    ↓
Phase 3: Mini Synthesis
    ├─ Receives question + context
    ├─ Makes NO tool calls
    └─ Streams answer to stdout
```

**Total latency:** 4-12s (vs 45-100s with primitives)

---

## Issues Identified

### 1. **Phase 2 Redundancy** 🔴 High Priority

**Problem:** Phase 2 (context assembly) is architecturally redundant. Nano already identified relevant messages in Phase 1, but then Phase 2 asks Nano to "add the relevant ones" from a pre-computed candidate list.

**Evidence:**
- Phase 1 collects `candidateMessageIds` and `candidateAttachmentIds` (lines 288-289, 416-432)
- Phase 2 receives these candidates and asks Nano to call `add_message`/`add_attachment` with IDs from the list (lines 625-627)
- Nano is essentially being asked to "select from this list" — a task that could be done deterministically

**Why this exists:** Likely evolved from an earlier design where Phase 1 only explored and Phase 2 curated. But now Phase 1 already collects candidates, making Phase 2 a redundant filter step.

**Impact:**
- Adds 1-2 extra LLM rounds (200-500ms each)
- Increases complexity (separate tool definitions, separate loop, separate state)
- Creates failure mode: Phase 2 could fail to add messages even when Phase 1 found them (line 718-729)

**Recommendation:** 
- **Option A:** Remove Phase 2 entirely. After Phase 1, directly use all `candidateMessageIds`/`candidateAttachmentIds` for context assembly.
- **Option B:** If curation is needed, do it deterministically in code (e.g., prioritize by date, relevance rank, limit to top-N).

**Code locations:**
- Phase 1 candidate collection: `src/ask/agent.ts:288-289, 416-432`
- Phase 2 assembly loop: `src/ask/agent.ts:636-735`
- Context set initialization: `src/ask/agent.ts:599-603`

---

### 2. **Complex State Tracking** 🟡 Medium Priority

**Problem:** The algorithm tracks 7+ interdependent state variables that are hard to reason about:

1. `candidateMessageIds` (Set) — collected in Phase 1
2. `candidateAttachmentIds` (Set) — collected in Phase 1
3. `lastWhoResults` (Array | null) — tracks who() results for auto-injection
4. `whoResultsAttemptCount` (number) — tracks attempts since who() call
5. `consecutiveFilteredFailures` (number) — tracks failed filtered searches
6. `investigationAttemptCount` (number) — tracks Phase 1 rounds
7. `assemblyAttemptCount` (number) — tracks Phase 2 rounds
8. `contextSet` (ContextSet) — Phase 2 output

**Issues:**
- `lastWhoResults` and `whoResultsAttemptCount` are used together but cleared inconsistently (lines 488, 504-505)
- `consecutiveFilteredFailures` is reset conditionally (lines 456, 451) — easy to miss edge cases
- State is mutated across multiple tool calls in loops, making it hard to trace

**Example complexity:**
```typescript
// Lines 365-409: Auto-injection logic with 3 nested conditions
if (toolName === "search" && lastWhoResults && lastWhoResults.length > 0 && whoResultsAttemptCount < 3) {
  const person = lastWhoResults[0];
  const allAddresses = person.addresses || [person.primaryAddress];
  if (!hasFromAddress && !hasToAddress) {
    // ... 20 lines of logic
  } else if (hasFromAddress && !hasToAddress) {
    // ... 10 lines of logic
  } else if (!hasFromAddress && hasToAddress) {
    // ... 10 lines of logic
  }
}
```

**Recommendation:**
- Extract state management into a class or structured object
- Use explicit state transitions (e.g., `investigationState.transitionTo('complete')`)
- Reduce interdependencies — e.g., don't track `whoResultsAttemptCount` separately from `investigationAttemptCount`

**Code locations:**
- State declarations: `src/ask/agent.ts:288-296`
- Auto-injection: `src/ask/agent.ts:365-409`
- State clearing: `src/ask/agent.ts:488, 504-505`

---

### 3. **Over-Engineered Auto-Injection** 🟡 Medium Priority

**Problem:** The `fromAddress`/`toAddress` auto-injection logic (lines 365-409) is complex and tries to be too clever. It:
- Automatically injects addresses from `who()` results
- Handles OR logic between `fromAddress` and `toAddress`
- Tracks attempt counts to prevent infinite injection
- Clears state conditionally based on search success

**Why this exists:** To reduce Nano's need to manually add `fromAddress` after calling `who()`. But the complexity suggests Nano isn't following instructions well, and this is a workaround.

**Issues:**
- Hard to reason about: When does injection happen? When does it stop?
- Creates implicit behavior: Nano might not realize addresses were injected
- Failure mode: If `who()` returns wrong person, injection propagates error
- The system prompt already instructs Nano to use `fromAddress` (line 278), so why is auto-injection needed?

**Evidence of fragility:**
- Line 365: `whoResultsAttemptCount < 3` — magic number
- Line 499: Conditional clearing based on `!autoInjectedFromAddress` — easy to miss
- Lines 440-453: Special handling for consecutive filtered failures — suggests injection isn't working well

**Recommendation:**
- **Option A:** Remove auto-injection entirely. Strengthen system prompt to require `fromAddress` after `who()` calls. If Nano fails, let it fail and improve the prompt.
- **Option B:** Simplify to single case: if `who()` was called and next search has no `fromAddress`, inject it. Remove OR logic, attempt tracking, conditional clearing.

**Code locations:**
- Auto-injection: `src/ask/agent.ts:365-409`
- State tracking: `src/ask/agent.ts:292-293, 480-510`

---

### 4. **Massive System Prompts** 🟡 Medium Priority

**Problem:** The Phase 1 system prompt is 280+ lines (lines 223-280) with extensive rules, examples, and edge cases. This creates:
- High token cost (every round includes full prompt)
- Hard to maintain (rules scattered throughout)
- Hard to debug (which rule applied?)

**Breakdown:**
- Date handling: ~30 lines (lines 227-230, 272-276)
- Search strategy: ~50 lines (lines 238-256)
- Person queries: ~20 lines (lines 258-263)
- Date filters: ~15 lines (lines 272-276)
- Edge cases: ~20 lines (lines 265-270)

**Issues:**
- Many rules are defensive (e.g., "DO NOT use hardcoded old dates") — suggests Nano was making mistakes
- Rules contradict each other (e.g., "use fromAddress after who" vs auto-injection logic)
- Examples are verbose (lines 246-253) — could be condensed

**Recommendation:**
- Extract rules into structured format (e.g., JSON schema with examples)
- Use few-shot examples instead of verbose instructions
- Move defensive rules to validation code (e.g., date validation already exists at lines 340-351)

**Code locations:**
- Phase 1 prompt: `src/ask/agent.ts:223-280`
- Phase 2 prompt: `src/ask/agent.ts:606-628`

---

### 5. **Inconsistent Error Handling** 🟢 Low Priority

**Problem:** JSON parsing errors are silently ignored throughout (lines 459, 474, 491, 507, 520, 680). This makes debugging harder.

**Examples:**
```typescript
try {
  const parsed = JSON.parse(result);
  // ... use parsed
} catch {
  // Ignore parse errors  ← Silent failure
}
```

**Issues:**
- If a tool returns malformed JSON, the algorithm continues as if nothing happened
- Errors are logged to stderr but not surfaced to user
- Makes it hard to diagnose why candidates weren't collected

**Recommendation:**
- Log parse errors to stderr with context (tool name, raw result snippet)
- Consider validating tool responses with a schema (e.g., Zod)
- At minimum, add `process.stderr.write` in catch blocks

**Code locations:**
- Silent catches: `src/ask/agent.ts:459, 474, 491, 507, 520, 680`

---

### 6. **Date Validation Duplication** 🟢 Low Priority

**Problem:** Date validation logic exists in two places:
1. System prompt instructions (lines 272-276) — tells Nano not to use old dates
2. Code validation (lines 340-351) — rejects old dates Nano generates

**Why this exists:** Defensive programming — prompt tells Nano what to do, code enforces it. But this suggests the prompt isn't effective.

**Recommendation:**
- Remove prompt instructions, rely on code validation
- Or: strengthen prompt with examples of correct behavior
- Consider: Is date validation even needed? If Nano generates "2023-01-01" for "last month" in 2026, that's a bug Nano should fix, not something we should silently correct.

**Code locations:**
- Prompt rules: `src/ask/agent.ts:272-276`
- Code validation: `src/ask/agent.ts:340-351`

---

### 7. **Attachment Filtering Complexity** 🟢 Low Priority

**Problem:** Attachment inclusion logic (`shouldIncludeAttachment`, lines 59-89) has multiple thresholds and conditions:
- Size limits (10 MB, 500 KB for non-text)
- Extracted text limits (50k chars per attachment, 200k total)
- Type exclusions (images/videos/audio)

**Issues:**
- Hard to reason about: When will an attachment be included?
- `totalAttachmentChars` is tracked per-message (line 124) but limit is global (line 65) — potential bug
- Rule-based filtering might exclude relevant attachments (e.g., a 12 MB PDF invoice)

**Recommendation:**
- Simplify to: include if size < 10 MB AND (text type OR extracted_text exists)
- Let Mini decide relevance from context, not pre-filter
- Or: make filtering configurable per-query (e.g., "include all attachments" flag)

**Code locations:**
- Filtering logic: `src/ask/agent.ts:59-89, 127-180`

---

## Positive Aspects

### ✅ **Clear Separation of Concerns**
- Phase 1: Exploration (metadata only)
- Context Assembler: Data fetching (pure code)
- Phase 3: Synthesis (no tool calls)

This separation is architecturally sound and makes the pipeline easy to understand.

### ✅ **Performance Optimization**
- Metadata-only tools in Phase 1 reduce token usage
- Streaming output in Phase 3 improves perceived latency
- Context caps prevent token bloat

### ✅ **Debug Logging**
- Extensive stderr logging makes debugging possible
- Logs show tool calls, results, state transitions

---

## Recommendations Summary

### High Priority
1. **Remove Phase 2 redundancy** — Use Phase 1 candidates directly for context assembly
2. **Simplify state management** — Extract to structured object, reduce interdependencies

### Medium Priority
3. **Simplify or remove auto-injection** — Either strengthen prompt or simplify to single case
4. **Condense system prompts** — Use few-shot examples, extract rules to code

### Low Priority
5. **Improve error handling** — Log parse errors, validate responses
6. **Remove date validation duplication** — Choose prompt OR code, not both
7. **Simplify attachment filtering** — Reduce thresholds, let LLM decide relevance

---

## Complexity Metrics

**Lines of code:**
- `agent.ts`: ~800 lines
- `tools.ts`: ~610 lines
- **Total:** ~1,410 lines

**State variables:** 8+ interdependent variables

**System prompt length:** ~280 lines (Phase 1) + ~30 lines (Phase 2) = **~310 lines**

**Tool definitions:** 6 tools (investigation) + 2 tools (assembly) = **8 tools**

**Nested conditionals:** Max depth 4-5 (auto-injection logic)

---

## Conclusion

The `ask` algorithm achieves its performance goals (4-10x faster than primitives) but at the cost of **significant complexity**. The most impactful simplification would be **removing Phase 2** — it's architecturally redundant and adds latency without clear benefit.

The complexity is not inherently wrong (it solves real problems like Nano not following instructions), but it creates maintenance burden and makes the algorithm harder to reason about. Prioritize removing redundancy first, then simplify state management and prompts.

**Estimated effort to simplify:**
- Remove Phase 2: 2-4 hours
- Simplify state: 4-8 hours
- Condense prompts: 2-4 hours
- **Total:** 8-16 hours for significant complexity reduction
