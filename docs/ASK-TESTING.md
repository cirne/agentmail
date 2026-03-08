# Test Coverage Analysis for `zmail ask`

**Status:** ❌ **Zero test coverage** - No tests exist for the `ask` module.

**Date:** 2026-03-08  
**Note:** This document serves as a reference for future test implementation work.

---

## Current State

### Files in `src/ask/`:
- `agent.ts` - Main pipeline orchestrator (Nano → Context assembler → Mini)
- `tools.ts` - Tool execution and definitions

### Test Files:
- ❌ `src/ask/agent.test.ts` - **Does not exist**
- ❌ `src/ask/tools.test.ts` - **Does not exist**

---

## What Needs Testing

### 1. `tools.ts` - Tool Execution

#### `executeNanoTool` function:
- ✅ **Date parsing** - Relative dates ("7d", "30d") → ISO dates
- ✅ **Search tool** - Executes search, returns metadata-only results
- ✅ **Who tool** - Executes who lookup
- ✅ **get_thread_headers tool** - Returns thread headers
- ✅ **Error handling** - Invalid tool names, execution errors
- ✅ **Result hints** - Adds hints for 0 results, low diversity, broad searches
- ✅ **hasEnoughContext** - Sets flag when results are sufficient

#### Helper functions (all private, but should be tested):
- `parseDateParam` - Date parsing logic
- `toMetadataResults` - Result conversion
- `addSearchHints` - Hint generation
- `checkResultDiversity` - Diversity checking
- `checkEnoughContext` - Context sufficiency
- `checkSearchBroadness` - Relevance checking
- `formatThreadResults` - Thread formatting

### 2. `agent.ts` - Pipeline Orchestration

#### `runAsk` function:
- ✅ **Nano loop** - Iterative search with MAX_TRIES (5)
- ✅ **Date handling** - Default 30d filter, "any"/"all" detection
- ✅ **Date validation** - Rejects old dates (>1 year)
- ✅ **Exit conditions** - Stops when enough context found
- ✅ **Result collection** - Collects message/thread IDs from searches
- ✅ **Relevance filtering** - Sorts by rank, filters low-relevance results
- ✅ **Context assembly** - Fetches full messages/threads
- ✅ **Mini synthesis** - Generates final answer
- ✅ **Streaming** - Streams answer to stdout
- ✅ **Error handling** - Missing API key, LLM errors, tool errors

#### Edge cases:
- Empty results (0 messages found)
- Max attempts reached without results
- Invalid date formats
- API key missing
- LLM API errors
- Tool execution failures

---

## Recommended Test Structure

### `src/ask/tools.test.ts`

```typescript
describe("executeNanoTool", () => {
  describe("search tool", () => {
    it("parses relative dates to ISO format");
    it("returns metadata-only results (no bodyPreview)");
    it("includes rank for relevance filtering");
    it("adds hint when 0 results");
    it("adds hint when totalMatched > limit");
    it("detects low diversity and adds hint");
    it("sets hasEnoughContext when results sufficient");
    it("handles date parsing errors gracefully");
  });

  describe("who tool", () => {
    it("returns people matching query");
    it("respects limit parameter");
  });

  describe("get_thread_headers tool", () => {
    it("returns thread headers");
    it("returns error when thread not found");
  });

  describe("error handling", () => {
    it("returns error for unknown tool");
    it("handles tool execution errors");
  });
});
```

### `src/ask/agent.test.ts`

**Challenge:** Requires mocking OpenAI API calls. Options:
1. **Mock OpenAI client** - Use vi.mock() to mock OpenAI SDK
2. **Integration tests** - Test against real API (requires API key, slower)
3. **Hybrid** - Unit tests with mocks + limited integration tests

```typescript
describe("runAsk", () => {
  describe("date handling", () => {
    it("applies default 30d filter when no dates specified");
    it("removes date filter when query says 'any'");
    it("rejects dates older than 1 year");
    it("respects explicit date ranges");
  });

  describe("nano loop", () => {
    it("stops when enough context found");
    it("continues when 0 results");
    it("respects MAX_TRIES limit");
    it("collects results from multiple searches");
  });

  describe("relevance filtering", () => {
    it("sorts results by rank");
    it("filters low-relevance results when too many");
    it("limits to top 100 most relevant");
  });

  describe("context assembly", () => {
    it("fetches messages by ID");
    it("fetches threads by ID");
    it("applies message/thread limits");
  });

  describe("error handling", () => {
    it("throws when OpenAI API key missing");
    it("handles LLM API errors");
    it("handles tool execution errors");
  });
});
```

---

## Testing Challenges

### 1. OpenAI API Mocking
**Problem:** `runAsk` calls OpenAI API (GPT-4.1 nano, GPT-4.1 mini).  
**Solution:** Mock OpenAI client using vitest `vi.mock()`:

```typescript
vi.mock("openai", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{
              message: {
                content: "test response",
                tool_calls: [...]
              }
            }]
          })
        }
      }
    }))
  };
});
```

### 2. Streaming Output
**Problem:** `runAsk` streams to `process.stdout`.  
**Solution:** Capture stdout or make streaming optional for tests.

### 3. Date Dependencies
**Problem:** Tests depend on current date for "last week", "30d", etc.  
**Solution:** Mock `Date` or use fixed dates in tests.

### 4. Complex State
**Problem:** Nano loop maintains conversation state across multiple LLM calls.  
**Solution:** Mock LLM responses to simulate different scenarios (0 results, enough context, etc.).

---

## Priority Test Cases

### High Priority (Critical Path)
1. ✅ Date parsing (relative → ISO)
2. ✅ Default 30d filter application
3. ✅ "Any"/"all" detection and date removal
4. ✅ Date validation (reject old dates)
5. ✅ Tool execution (search, who, get_thread_headers)
6. ✅ Result collection and deduplication
7. ✅ Exit conditions (enough context, MAX_TRIES)

### Medium Priority (Edge Cases)
8. ⚠️ Empty results handling
9. ⚠️ Error handling (missing API key, LLM errors)
10. ⚠️ Relevance filtering logic
11. ⚠️ Context assembly limits

### Low Priority (Nice to Have)
12. 📝 Streaming output
13. 📝 Debug logging
14. 📝 Performance benchmarks

---

## Recommended Approach

### Phase 1: Unit Tests for `tools.ts`
- Test tool execution functions in isolation
- Mock database (use `createTestDb()`)
- Test date parsing, result formatting, hints
- **Effort:** ~2-3 hours
- **Value:** High - catches bugs in tool execution

### Phase 2: Integration Tests for `agent.ts`
- Mock OpenAI API calls
- Test full pipeline with realistic scenarios
- Test date handling, loop logic, exit conditions
- **Effort:** ~4-6 hours
- **Value:** High - validates end-to-end behavior

### Phase 3: E2E Tests (Optional)
- Test against real OpenAI API (requires API key)
- Test with real email data
- **Effort:** ~2-3 hours
- **Value:** Medium - catches integration issues, but slow/expensive

---

## Comparison with Other Modules

| Module | Test Coverage | Test File |
|--------|--------------|-----------|
| `search` | ✅ Comprehensive | `src/search/search.test.ts` (763 lines) |
| `who` | ✅ Good | `src/search/who.test.ts` (315 lines) |
| `mcp` | ✅ Good | `src/mcp/index.test.ts` (484 lines) |
| `ask` | ❌ **None** | **Missing** |

**Gap:** The `ask` module is one of the most complex (Nano loop, tool execution, LLM calls) but has zero test coverage.

---

## Next Steps

1. **Create `src/ask/tools.test.ts`** - Start with unit tests for tool execution
2. **Create `src/ask/agent.test.ts`** - Add integration tests with mocked OpenAI
3. **Add to CI** - Ensure tests run on every commit
4. **Document test patterns** - Help future contributors write tests

---

## See Also

- [OPP-020](../opportunities/OPP-020-answer-engine-local-agent.md) - Answer engine architecture and design philosophy
- [ASK.md](./ASK.md) - How agents use `zmail ask`
