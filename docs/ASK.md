# Using `zmail ask` as a Higher-Level Query Interface

**For agents integrating with zmail** — This document explains how agents can use `zmail ask` as a high-level abstraction instead of orchestrating zmail's primitive tools directly.

---

## The Problem: Orchestration Overhead

When agents use zmail's primitive MCP tools (`search_mail`, `get_message`, `who`, `get_thread`, etc.) directly, they must:

1. **Understand zmail's tool schema** — learn parameters, response shapes, when to use each tool
2. **Orchestrate multiple tool calls** — decide search strategy, follow up with reads, combine results
3. **Synthesize answers themselves** — extract information from structured JSON and produce natural language responses
4. **Handle edge cases** — empty results, date parsing, ID normalization, pagination

This creates **high latency** because:
- Each tool call requires a full LLM round-trip (15-25s with powerful models like Opus 4.6)
- Complex queries need 3-4 rounds (search → read → follow-up → synthesize) = ~50-100s total
- The orchestrating agent carries heavy context (50k+ tokens) and complex tool schemas

**Example:** To answer "who is marcio nunes and how do I know him?", an agent must:
1. Call `who` with query "marcio nunes" → get email address
2. Call `search_mail` with `fromAddress` → get message list
3. Call `get_thread` for relevant threads → get full conversations
4. Synthesize the answer from structured JSON

That's **3-4 LLM rounds** at 15-25s each = **45-100s total**.

---

## The Solution: `zmail ask`

`zmail ask` moves all orchestration **inside zmail** using a fast, specialized pipeline:

```
Agent → zmail ask "<question>" → synthesized answer (streaming)
```

**Single subprocess call, zero orchestration overhead.**

### How It Works Internally

`zmail ask` uses a **4-step pipeline** optimized for speed:

1. **Planner (GPT-4.1 nano)** — Single call with JSON output (~300ms)
   - Analyzes the question and produces a structured search plan
   - Outputs keyword patterns, optional domain/date filters, and noise inclusion flag
   - No tool calls — pure planning decision

2. **Scatter (pure code)** — Parallel FTS5 execution (~50ms)
   - Executes all search patterns in parallel via `Promise.all`
   - Deduplicates results by message ID, preserving best FTS5 rank
   - Applies metadata filters (fromAddress, date range, noise)

3. **Assemble (pure code)** — Tiered context assembly (~100ms)
   - Builds context from search hits using tiered relevance
   - Tier 1 (subject match or strong rank): up to 3000 chars
   - Tier 2 (any FTS match): up to 800 chars
   - Tier 3 (filter-only match): 150-char snippet
   - Includes attachment extraction, applies 80k char cap

4. **Synthesize (GPT-4.1 nano)** — Final answer generation (~500ms-1s)
   - Receives original question + assembled context
   - Makes **no tool calls** — pure synthesis
   - Streams answer to stdout

**Total latency: 1.5-3s** (target), measured 4-10s on eval fixtures (vs 45-100s with primitive tools)

---

## Comparison: Primitives vs `ask`

### Example 1: Person Lookup

**Using primitives (agent orchestrates):**
```python
# Agent must:
1. who({"query": "marcio nunes"})  # Round 1: 15-25s
   → {"people": [{"primaryAddress": "marcio@vergemktg.com"}]}

2. search_mail({"fromAddress": "marcio@vergemktg.com"})  # Round 2: 15-25s
   → {"results": [{"messageId": "<id1>", "threadId": "<tid1>"}]}

3. get_thread({"threadId": "<tid1>"})  # Round 3: 15-25s
   → {"messages": [...]}

4. Synthesize answer from JSON  # Round 4: 15-25s
   → "Marcio Nunes is the CEO & Founder of Harmonee AI..."

Total: ~60-100s, 4 LLM rounds
```

**Using `zmail ask` (single call):**
```bash
zmail ask "who is marcio nunes and how do I know him?"
# → Streaming answer: "Marcio Nunes is the CEO & Founder of Harmonee AI..."

Total: ~4-12s, 0 agent LLM rounds
```

### Example 2: Spending Summary

**Using primitives:**
```python
# Agent must:
1. search_mail({"query": "apple.com", "afterDate": "30d"})  # Round 1
2. search_mail({"query": "receipt", "afterDate": "30d"})  # Round 2
3. get_messages({"messageIds": [...]})  # Round 3
4. Extract amounts, dates, synthesize  # Round 4

Total: ~60-100s, 4 LLM rounds
```

**Using `zmail ask`:**
```bash
zmail ask "summarize my spending on apple.com in the last 30 days"
# → Streaming answer with detailed breakdown

Total: ~11-12s, 0 agent LLM rounds
```

---

## When to Use Each Approach

### Use `zmail ask` when:

✅ **You want a natural language answer** — "who is X?", "summarize my spending", "what emails did I get today?"

✅ **You need fast answers** — prioritize latency over control

✅ **You don't need structured data** — the answer is text, not JSON to parse

✅ **You want zmail to handle orchestration** — let the specialized pipeline optimize retrieval

✅ **You're building a conversational interface** — user asks questions, agent returns answers

### Use primitive tools when:

✅ **You need structured data** — you want JSON arrays/objects to process programmatically

✅ **You need fine-grained control** — specific search parameters, pagination, detail levels

✅ **You're building a tool/UI** — you need to display search results, message lists, etc.

✅ **You need incremental exploration** — user clicks through results, drills into threads

✅ **You're debugging or inspecting** — you want to see raw search results, message metadata

---

## Integration Patterns

### Pattern 1: Subprocess Call (CLI)

**Best for:** Agents that can execute shell commands

```python
import subprocess

def ask_zmail(question: str) -> str:
    """Call zmail ask and return the answer."""
    result = subprocess.run(
        ["zmail", "ask", question],
        capture_output=True,
        text=True,
        timeout=30  # Most queries complete in <15s
    )
    if result.returncode != 0:
        raise RuntimeError(f"zmail ask failed: {result.stderr}")
    return result.stdout.strip()
```

**Usage:**
```python
answer = ask_zmail("who is marcio nunes and how do I know him?")
# → "Marcio Nunes is the CEO & Founder of Harmonee AI..."
```

### Pattern 2: MCP Tool (Future)

**Best for:** Agents with MCP support (when `ask_email` tool is added)

```json
{
  "tool": "ask_email",
  "arguments": {
    "question": "summarize my spending on apple.com in the last 30 days"
  }
}
```

**Response:**
```json
{
  "answer": "In the last 30 days, your spending on apple.com includes...",
  "sources": ["<message-id-1>", "<message-id-2>"],
  "pipelineMs": 11550
}
```

**Note:** MCP tool integration is **deferred** until CLI prototype validates performance. See [OPP-020](../opportunities/OPP-020-answer-engine-local-agent.md) for phasing.

### Pattern 3: Hybrid Approach

**Use `ask` for Q&A, primitives for structured data:**

```python
# Fast Q&A
answer = ask_zmail("what newsletters did I get this week?")

# Structured exploration (if user wants to drill in)
if user_wants_details:
    results = mcp_client.call("search_mail", {
        "query": "newsletter",
        "afterDate": "7d"
    })
    # Display results in UI
```

---

## Performance Characteristics

### Latency Comparison

| Query Type | Primitives (Opus 4.6) | `zmail ask` | Improvement |
|------------|----------------------|-------------|-------------|
| Person lookup | ~60-100s (4 rounds) | ~1.5-3s (target) | **20-67x faster** |
| Spending summary | ~60-100s (4 rounds) | ~1.5-3s (target) | **20-67x faster** |
| Today's emails | ~45-75s (3 rounds) | ~1.5-3s (target) | **15-50x faster** |

**Target:** `zmail ask` achieves **≥50% latency improvement vs Google MCP** (e.g., ~50s → ~25s). Current results show **4-10x improvement** over primitive orchestration on eval fixtures (measured 4-10s), with target of 1.5-3s for simpler queries.

### Cost Comparison

| Approach | Cost per Query | Notes |
|----------|---------------|-------|
| Primitives (Opus 4.6) | ~$0.10-0.20 | 3-4 rounds × $0.03-0.05/round |
| `zmail ask` (Nano + Nano) | ~$0.001-0.005 | Two Nano calls: $0.10/1M tokens each |

**Cost savings: ~10-20x** per query.

---

## Debugging and Transparency

### Comparing algorithms

The default pipeline is **Planner → Scatter → Assemble → Synthesize** (`src/ask/agent.ts`). To run **v1** for A/B comparison (Nano tool loop + Mini synthesis), use:

```bash
zmail ask --v1 "your question"
```

Same flags apply (`--verbose`, etc.). This loads `src/ask/agent-v1.ts`.

### Verbose logging

`zmail ask` writes debug logs to `stderr` (use `--verbose` flag):

```
[pipeline] step 1: planner
[planner] calling Nano to generate search plan
[planner] generated plan: 4 patterns, fromAddress=apple.com, afterDate=30d, includeNoise=false
[pipeline] step 2: scatter
[pipeline] step 3: assemble
[pipeline] assembled 46187 chars from 29 hits
[pipeline] step 4: synthesize
pipelineMs: 11550
```

**To see debug output:**
```bash
zmail ask "your question" 2>&1 | tee output.log
# stdout = answer
# stderr = debug logs
```

**To suppress debug logs:**
```bash
zmail ask "your question" 2>/dev/null
```

---

## Limitations and Tradeoffs

### Limitations

- **Requires OpenAI API key** — `ZMAIL_OPENAI_API_KEY` must be set
- **No structured output** (Phase 1) — returns text, not JSON with sources/metadata
- **No fine-grained control** — can't specify search parameters, detail levels, pagination
- **Less transparent** — internal tool calls are hidden (debug logs help)

### Tradeoffs

- **Speed vs Control** — `ask` prioritizes speed; primitives give control
- **Simplicity vs Flexibility** — `ask` is simpler; primitives are more flexible
- **Cost vs Quality** — `ask` uses cheaper models; primitives can use more powerful models

---

## Future Enhancements

See [OPP-020](../opportunities/OPP-020-answer-engine-local-agent.md) for roadmap:

- **Phase 2:** MCP `ask_email` tool for programmatic access
- **Phase 2:** Structured JSON output (answer + sources + metadata)
- **Phase 2:** Rule-based shortcuts for common patterns
- **Phase 3:** Semantic search integration (if needed)

---

## See Also

- [OPP-020](../opportunities/OPP-020-answer-engine-local-agent.md) — Answer engine architecture, phasing, and design philosophy
- [MCP.md](./MCP.md) — Primitive tool reference and agent interface documentation
- [AGENTS.md](../AGENTS.md) — Development guide and CLI reference
