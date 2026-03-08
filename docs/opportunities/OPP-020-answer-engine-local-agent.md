# OPP-020: Answer Engine — Local Agent for 10x Faster Email Queries

**Status:** Proposed experiment. **Created:** 2026-03-08.

**Problem:** zmail is 2-5x slower than Gmail MCP in bakeoff testing despite having faster tool execution. The bottleneck is not zmail — it's the number of LLM rounds required by the orchestrating agent (Claude, GPT, etc.). Each tool call round costs 15-25s in LLM deliberation. A typical query takes 3-4 rounds (search → read → follow-up → synthesize) = 60-100s wall clock. 91-99% of that time is LLM thinking, not tool execution.

**Constraint:** No optimization to zmail's tools can fix this. Making search 100x faster saves milliseconds. The only path to 5-10x improvement is reducing the number of LLM rounds — ideally to zero.

**Proposed direction:** Make zmail an **answer engine**, not a tool library. Instead of exposing primitives (search, read, get_thread) for an external LLM to orchestrate across multiple rounds, zmail accepts a natural-language question and returns a synthesized answer. The multi-step orchestration happens inside zmail's own pipeline, using a fast/cheap model, with zero external LLM rounds.

---

## The Performance Gap

### Bakeoff data (2026-03-07)

| Interface | Tool calls | Wall-clock | LLM thinking % |
|-----------|-----------|-----------|----------------|
| zmail CLI | 8 (12 tool uses) | 99s | 99% |
| zmail MCP | 11 (19 tool uses) | 96s | 97% |
| Gmail MCP | 13 tool uses | 74s | 91% |

Gmail won despite having more tool calls and slower individual calls. Its structured responses are information-dense — agents extract what they need faster and synthesize sooner.

### Why this can't be fixed incrementally

OPP-018 (richer search output, batch reads) targets 99s → ~45s by collapsing 3-4 rounds to 1-2. That's a 2x improvement — valuable, but not the 5-10x needed to make zmail feel qualitatively different from Gmail MCP.

The fundamental constraint: **each LLM round costs 15-25s, and that cost is external to zmail.** The only way to break through is to eliminate rounds.

| Approach | Expected wall clock | Improvement |
|----------|-------------------|-------------|
| Current architecture | 96-99s | baseline |
| OPP-018 (richer responses) | ~45s | ~2x |
| Skill + OPP-018 | ~35s | ~3x |
| Answer engine (via MCP tool) | ~15-20s | 5-7x |
| Answer engine (standalone CLI) | 2-5s | 20-50x |
| Pre-built intents (no LLM for planning) | 1-3s | 30-100x |

---

## Architecture: "zmail ask"

### The idea

Replace multi-round LLM orchestration with a single-call pipeline:

```
User or agent → zmail ask "summarize my tech news this week" → synthesized answer
```

### Internal pipeline

```
1. Intent classification (rule-based + fast LLM fallback)
   Input:  "summarize my tech news this week"
   Output: { intent: "summarize", topic: "tech news", timeframe: "7d" }
   Cost:   <100ms (rules) or ~500ms (fast model)

2. Query execution (pure code — no LLM)
   → search(db, { query: "tech news newsletter", afterDate: "7d", limit: 10 })
   → retrieve bodies for top results
   Cost:   <50ms (SQLite FTS5 + body fetch)

3. Synthesis (fast model, tight prompt, streaming)
   → System: "You are a concise email summarizer."
   → User: "Summarize these 8 newsletter excerpts. Key stories only."
   → [email bodies as context]
   Cost:   1-3s (GPT-4.1 mini or Haiku with small context)

Total: 2-5s standalone, ~15-20s if called as MCP tool by outer LLM
```

### Two modes of operation

**Standalone CLI (2-5s):**
```bash
zmail ask "what's my flight to cabo?"
zmail ask "summarize spending on apple.com last 30 days"
zmail ask "who is marcio nunes and how do I know him?"
```

The user (or a script, or a voice assistant) calls zmail directly. No outer LLM. The answer streams to stdout. This is the fastest possible path.

**MCP tool (15-20s):**
```json
{ "tool": "ask_email", "arguments": { "question": "summarize my tech news" } }
```

An outer LLM (Claude in Cursor, GPT in another harness) calls a single tool. One LLM round (~15s) + zmail internal pipeline (2-5s). Still 5-7x faster than the current multi-round workflow.

### Why the internal model is fast

The outer LLM in Cursor/Claude Code is slow because it processes a massive context on every round:
- Full conversation history (often 50k+ tokens)
- All tool schemas and descriptions
- System prompt, user rules, file contents
- Tool call/response pairs from prior rounds

zmail's internal model sees only:
- A tight system prompt (~200 tokens)
- The user's question (~20 tokens)
- The relevant email bodies (~2000-5000 tokens)

Small context = fast inference. A model like GPT-4.1 mini or Claude Haiku with 3-5k input tokens responds in 1-2s.

---

## Model Selection

The internal model should be:
- **Fast:** 1-3s response time for typical queries
- **Cheap:** pennies per query, not dollars
- **Good enough:** doesn't need to be frontier-quality — the task is summarization and extraction over pre-selected content, not open-ended reasoning

Candidates:

| Model | Speed | Cost (per 1M tokens) | Notes |
|-------|-------|---------------------|-------|
| GPT-4.1 mini | ~1-2s | $0.40 in / $1.60 out | Strong, fast, cheap |
| GPT-4.1 nano | <1s | $0.10 in / $0.40 out | Fastest, may be too weak for complex synthesis |
| Claude 3.5 Haiku | ~1-2s | $0.80 in / $4.00 out | Good quality, moderate cost |
| Local (Llama 3, Phi-3) | varies | free | No API dependency, but requires GPU or is slow on CPU |

**Recommendation for experiment:** Start with GPT-4.1 mini. It's the best speed/quality/cost balance. The `ZMAIL_OPENAI_API_KEY` infrastructure already exists.

---

## Intent Classification

Not every query needs an LLM for planning. Many common patterns can be handled with rules:

### Rule-based intents (no LLM, <10ms)

```
"tech news"              → search newsletters from last 24-48h, summarize
"spending on X"          → from:X.com receipts, extract amounts, total
"flight to X"            → search travel/booking/confirmation + X, extract itinerary
"who is X"               → who(X) + recent messages, synthesize relationship
"what did X say about Y" → from:X + Y, return relevant excerpts
```

These are deterministic pipelines. The query pattern maps directly to a search strategy and a synthesis prompt template. Sub-second for the search, 1-2s for synthesis.

### LLM-assisted intent (fast model, ~500ms)

For queries that don't match a rule:

```
"that stressful email from last month"
"find the contract with the non-compete clause"
"what decisions were made in the Q3 planning thread"
```

A fast model (nano/mini) classifies the intent and generates search parameters:

```
Input:  "that stressful email from last month"
Output: {
  searches: [
    { query: "urgent deadline stress", afterDate: "30d", limit: 5 },
    { query: "frustrated disappointed concerned", afterDate: "30d", limit: 5 }
  ],
  synthesisGoal: "identify the email the user is thinking of"
}
```

This is a structured-output call with a tight schema — fast models excel at this.

---

## What Gets Returned

### For standalone CLI

Stream the answer to stdout as it generates. The user sees the answer progressively, like a conversation:

```
$ zmail ask "summarize my tech news this week"

Here are the key tech stories from your newsletters this week:

**AI & LLMs**
- OpenAI released GPT-4.1, a model focused on instruction following and
  coding. Available in mini and nano variants...
- Anthropic announced...

**Industry**
- Apple's WWDC dates confirmed for June...

Sources: TLDR (Mar 7, Mar 6, Mar 5), The Information (Mar 7), ...
```

### For MCP tool

Return structured JSON so the outer LLM can incorporate the answer:

```json
{
  "answer": "Here are the key tech stories...",
  "sources": [
    { "messageId": "<abc>", "subject": "TLDR 2026-03-07", "from": "tldr@example.com" },
    { "messageId": "<def>", "subject": "The Information Daily", "from": "newsletters@theinformation.com" }
  ],
  "searchesRun": ["tech news newsletter after:7d"],
  "messagesRead": 8,
  "modelUsed": "gpt-4.1-mini",
  "pipelineMs": 2847
}
```

Sources let the outer LLM cite specific emails or drill deeper if needed. `searchesRun` provides transparency into what zmail did.

---

## Approaches Considered

### 1. Better documentation / Cursor skill (rejected as primary strategy)

A skill teaching Claude the optimal zmail query patterns would reduce wasted rounds (e.g., teaching `from:apple.com` instead of `"apple.com"`). But it cannot overcome the 15-25s per-round floor. Expected improvement: ~3x (100s → 35s). Not enough.

**Still worth doing** as a complement — if the outer LLM does call zmail tools, a skill helps. But it's not the 10x lever.

### 2. Richer tool responses / OPP-018 (complementary, not sufficient)

Body previews, batch reads, attachment indicators — these reduce rounds from 3-4 to 1-2. Expected improvement: ~2x (100s → 45s). Valuable and should still be implemented, but doesn't reach the 5-10x target.

**These improvements also help the answer engine** — richer search results mean the internal pipeline has more to work with before needing follow-up queries.

### 3. Answer engine with current semantic search (rejected)

Branching off main (which had LanceDB + per-query OpenAI embeddings) was considered. The reasoning: if zmail controls the pipeline, embedding latency (~500ms) is hidden inside a 2-5s operation.

**Rejected because:** The current semantic implementation (LanceDB + OpenAI API per query) is the wrong architecture regardless. If semantic search is reintroduced for the answer engine, it should use:
- **sqlite-vec** — embeddings in SQLite, one file, no LanceDB dependency
- **Local or index-time embeddings** — no per-query API call
- Tight integration with the query planner, not generic hybrid RRF merge

This is a Phase 2 optimization (see below), not a prerequisite for the experiment.

### 4. Pre-built intent shortcuts (included as Phase 1b)

Deterministic pipelines for common patterns (`zmail news`, `zmail spending`, `zmail flights`) that don't need any LLM for query planning. Sub-second search + 1-2s synthesis. These are the lowest-hanging fruit and can be built alongside the general `ask` command.

---

## Phasing

### Phase 1: Validate the architecture (the experiment)

**Goal:** Can `zmail ask "summarize my tech news"` return a good answer in <5s?

**Scope:**
- `zmail ask <question>` CLI command
- Rule-based intent classification for 2-3 common patterns (news summary, spending, person lookup)
- GPT-4.1 mini for synthesis
- Streaming output to stdout
- Simple prompt templates per intent

**Success criteria:**
- Wall clock <5s for rule-based intents
- Wall clock <8s for LLM-assisted intents
- Answer quality comparable to what Claude produces with 3-4 zmail tool calls

**Non-goals for Phase 1:**
- MCP `ask_email` tool (add after CLI validates)
- Semantic search / embeddings
- Extensive intent coverage
- Production error handling

### Phase 1b: Pre-built intents

- `zmail news` — today's newsletters, auto-summarized
- `zmail spending <vendor>` — receipts from vendor, amounts extracted and totaled
- `zmail recap` — daily email digest

### Phase 2: MCP integration + broader coverage

- Add `ask_email` MCP tool for outer LLM integration
- LLM-assisted intent classification for arbitrary questions
- Expand rule-based intents based on real usage
- Decide primitive tools strategy (keep, deprecate, or make `ask_email` the recommended default)

### Phase 3: Semantic search (if needed)

- sqlite-vec for embeddings stored in SQLite
- Local embedding model (transformers.js / ONNX) or index-time-only API embedding
- Query planner decides FTS vs semantic per-query
- Only pursue if Phase 1/2 reveal queries where FTS + intent decomposition fails

---

## Tradeoffs and Risks

### Benefits

- **5-20x faster wall clock** for the most common email queries
- **Works standalone** — no dependency on an outer LLM for simple questions
- **Model control** — zmail picks the fastest/cheapest model for the task
- **Prompt engineering** — tight, purpose-built prompts vs. generic tool-use context
- **Streaming** — answers appear progressively, feel instant

### Risks

- **API key dependency** — requires `ZMAIL_OPENAI_API_KEY` (or another provider). Currently optional; this makes it load-bearing for the `ask` feature. Mitigatable with local models later.
- **Answer quality ceiling** — fast/cheap models may produce worse synthesis than frontier models. The bet: for email summarization (not open-ended reasoning), mini-class models are sufficient.
- **Scope creep in intent classification** — the long tail of possible questions is infinite. Rule-based intents cover common cases; the LLM fallback handles the rest, but may be slow or imprecise.
- **Two LLMs in MCP mode** — when used as an MCP tool, there's an outer LLM (for routing) and an inner LLM (for synthesis). This is architecturally unusual and may confuse users or create debugging challenges.
- **Transparency** — users/agents can't see what zmail searched or read. Mitigated by including `sources` and `searchesRun` in the response.
- **Maintenance of two interfaces** — primitive tools (search, read, etc.) and the answer engine. Need a clear story for when to use which.

### Open questions

- **Should primitive MCP tools remain?** The answer engine handles the 80% case. Complex multi-step queries ("find the contract attachment from Fred and compare it to the one from last quarter") may still need primitive tools. Keep both, with guidance on when to use which?
- **Streaming protocol for MCP:** MCP's current response model is request/response, not streaming. The standalone CLI can stream, but the MCP tool returns a complete response. Is the synthesis fast enough (~2s) that streaming doesn't matter?
- **Cost per query:** GPT-4.1 mini at ~5k input tokens + ~500 output tokens = ~$0.003 per query. Acceptable for personal use. Worth tracking.
- **Local model viability:** Can a local model (Llama 3 8B, Phi-3) running on CPU produce acceptable synthesis quality in <5s? This would eliminate the API dependency entirely. Worth testing in Phase 2.
- **How does this change zmail's positioning?** zmail moves from "tool library for agents" to "intelligent email assistant." That's a bigger product — is it the right product?

---

## Relationship to Other Work

| Item | Impact |
|------|--------|
| **OPP-018** (reduce round-trips) | Still valuable — richer search results help the answer engine's internal pipeline too. Complementary, not replaced. |
| **OPP-019** (FTS-first) | Confirmed and reinforced. The answer engine uses FTS for retrieval. Semantic search deferred to Phase 3. |
| **OPP-002** (local embeddings) | Deferred. If semantic is reintroduced, sqlite-vec + local model is the path, not the prior LanceDB approach. |
| **BUG-016** (exhaustive search) | Still relevant — the answer engine's spending/receipt intents need exhaustive `from:` queries. Domain auto-routing fix benefits both architectures. |
| **STRATEGY.md** | May need updating. The answer engine shifts zmail from "queryable dataset for agents" toward "intelligent email assistant." The local-index moat argument still holds — the answer engine runs on the local index. |

---

## References

- Bakeoff performance data: OPP-018, BUG-016
- FTS-first decision: OPP-019
- STRATEGY.md — competitive positioning
- VISION.md — "just works in the agent" user promise
- Prior art: Perplexity (search → synthesize), Phind (code search → answer), RAG pipelines generally
