# OPP-020: Answer Engine — Local Agent for Faster Email Queries

**Status:** Proposed experiment. **Created:** 2026-03-08. **Updated:** 2026-03-08.

**Problem:** zmail matches or slightly lags Gmail MCP in bakeoff wall-clock time despite faster individual tool execution. The bottleneck is the orchestrating agent: high tool count and complex tool interface force use of a high-power/slower LLM (e.g. Opus 4.6). Each round costs 15-25s. A typical query takes 3-4 rounds (search → read → follow-up → synthesize) = ~50-100s. The vast majority of that time is LLM deliberation, not tool execution.

**Constraint:** Optimizing zmail's primitive tools cannot fix this. The only path to meaningful improvement is to move orchestration inside zmail: a faster/smaller LLM focused on email Q&A, with a purpose-built internal tool interface, so the user (or a future agent interface) sees a single "ask" and gets an answer — with zero or one external LLM round.

**Proposed direction:** Make zmail an **answer engine**. Expose a single interface (e.g. `zmail ask "<question>"`) that returns a synthesized answer. All multi-step orchestration runs inside zmail: an internal micro-agent loop with email-native tools, a tiny context, and a fast/cheap model. External interface (MCP tool, agent harness, UI) is deferred; the prototype is CLI-only. Success is validated by re-running the same bakeoff questions and achieving **at least 50% latency improvement vs Google MCP** (e.g. ~50s → ~25s), with room for further gains. zmail may later become the agent that manages email (and calendar); the UI or agent interface comes later.

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

OPP-018 (richer search output, batch reads) would reduce rounds and help, but the fundamental constraint remains: **each external LLM round costs 15-25s.** The current approach needs a powerful/slower model (Opus 4.6) to orchestrate many tools well. The only way to break through is to move orchestration inside zmail with a faster/smaller model and a brilliant internal tool interface.

**Validation target:** Re-run the same bakeoff questions against the new answer-engine flow. Success = **at least 50% latency improvement vs Google MCP** (e.g. ~50s → ~25s). We have enough bakeoff results to compare. Further improvement (e.g. toward 15-20s) is low-hanging fruit after that.

| Approach | Expected wall clock | Notes |
|----------|---------------------|-------|
| Current (zmail MCP + Opus) | ~96-99s | Baseline; ≈ equal to Gmail MCP |
| Google MCP (bakeoff) | ~74s | Comparison baseline |
| Answer engine (CLI prototype) | Target ≤25s | 50%+ improvement vs Gmail; validate first |
| Answer engine (tuned) | 15-20s | Room for improvement after validation |
| Answer engine (future MCP tool) | 15-20s + 1 outer round | If/when we expose ask as a tool |

---

## Architecture: "zmail ask"

### The idea

Single entry point; all orchestration inside zmail:

```
User → zmail ask "summarize my tech news this week" → synthesized answer (streaming)
```

No hardcoded pipeline. An **internal micro-agent** runs an agentic loop: the fast LLM chooses which internal tools to call (search, get_messages, who, get_thread, etc.), executes them locally (sub-millisecond), and repeats until it has enough to answer. Each internal round is cheap (~200-500ms LLM + negligible tool time), so 3-4 rounds still land under the latency target. Specialization is not "five fixed query types" — it's **"I know how to find answers in email lightning fast in a very small number of turns."**

### Internal tool interface (purpose-built, not external)

The interface between the internal LLM and zmail is **entirely different** from what we would expose externally. It is designed for one consumer: the fast model.

- **Email-native primitives:** search (FTS + from/to/date/subject), get_messages (batch bodies with previews), who (resolve person → addresses + relationship), get_thread (full conversation). Information-dense responses so the model often needs fewer rounds.
- **No prescriptive flow:** the model decides order and how many steps. Aim for as few turns as possible; no hard cap.
- **Swappable LLM provider:** easy to support (e.g. OpenAI, Anthropic). No dependency on Pi or other harnesses; we own the loop.

External interface (MCP tool, agent harness, richer CLI) is **deferred**. For the prototype, the only surface we expose is `zmail ask "<question>"`.

### Why the internal model is fast

The outer LLM (e.g. Opus in Cursor) is slow because every round carries:
- Full conversation history (often 50k+ tokens)
- All tool schemas and descriptions
- System prompt, user rules, file contents
- Prior tool call/response pairs

zmail's internal model sees only:
- A tight system prompt (~200 tokens)
- The user's question (~20 tokens)
- Tool definitions (small set) and the last few tool results (~2-5k tokens)

Small context = fast inference. A model like GPT-4.1 mini or Claude Haiku with 3-5k input tokens responds in 1-2s per round.

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

## Intent and retrieval (no fixed flow)

We do **not** rely on a fixed set of rule-based intents as the foundation. The internal agent uses **LLM-driven tool use** as the primary path: the model sees the question and the internal tools (search, get_messages, who, get_thread), and decides what to call. That works for any question shape. Rule-based shortcuts for common patterns (e.g. "tech news", "spending on X", "who is X") can be added later as optimizations to reduce turns or latency; they are not required for Phase 1.

The internal tools are designed so that the fast LLM can get maximum signal per call (information-dense, email-native), keeping the number of internal rounds low. No hardcoded pipeline; the model controls the flow.

### Design Philosophy: Generalized vs Overfitted

The answer engine avoids overfitting to specific test cases (e.g., "try apple.com when searching for apple"). Instead, it uses **generalized mechanisms** that work for any query:

- **Result feedback** — tools provide hints based on result patterns (0 results, low diversity, more available)
- **High default limits** — 50+ results by default catches more cases without hardcoding
- **General prompt guidance** — "try variations if 0 results" works for any query type

**Why this is better:**
- Works for any domain (Apple, Amazon, travel, events, etc.)
- Adapts to new query types without prompt changes
- Tool feedback guides the model dynamically, not hardcoded rules

---

## What gets returned (Phase 1: CLI only)

Stream the answer to stdout as the model generates. Optionally include timing or metadata (e.g. pipeline ms, model used) for bakeoff comparison — same questions, measure wall clock vs Google MCP.

Example:

```
$ zmail ask "summarize my tech news this week"

Here are the key tech stories from your newsletters this week:

**AI & LLMs**
- OpenAI released GPT-4.1...
- Anthropic announced...

**Industry**
- Apple's WWDC dates confirmed for June...

Sources: TLDR (Mar 7, Mar 6), The Information (Mar 7), ...
```

When we later expose an external interface (e.g. MCP `ask_email`), we can return structured JSON (answer, sources, searchesRun, pipelineMs) so callers can cite or drill deeper. Deferred for Phase 1.

---

## Approaches Considered

### 1. Better documentation / Cursor skill (rejected as primary strategy)

A skill teaching Claude the optimal zmail query patterns would reduce wasted rounds (e.g., teaching `from:apple.com` instead of `"apple.com"`). But it cannot overcome the 15-25s per-round floor. Expected improvement: ~3x (100s → 35s). Not enough.

**Still worth doing** as a complement — if the outer LLM does call zmail tools, a skill helps. But it's not the 10x lever.

### 2. Richer tool responses / OPP-018 (complementary, not sufficient)

Body previews, batch reads, attachment indicators — these reduce rounds from 3-4 to 1-2. Expected improvement: ~2x. Valuable and complementary, but moving orchestration inside zmail (answer engine) is what delivers the 50%+ latency win vs Google MCP.

**These improvements also help the answer engine** — richer search results mean the internal pipeline has more to work with before needing follow-up queries.

### 3. Answer engine with current semantic search (rejected)

Branching off main (which had LanceDB + per-query OpenAI embeddings) was considered. The reasoning: if zmail controls the pipeline, embedding latency (~500ms) is hidden inside a 2-5s operation.

**Rejected because:** The current semantic implementation (LanceDB + OpenAI API per query) is the wrong architecture regardless. If semantic search is reintroduced for the answer engine, it should use:
- **sqlite-vec** — embeddings in SQLite, one file, no LanceDB dependency
- **Local or index-time embeddings** — no per-query API call
- Tight integration with the query planner, not generic hybrid RRF merge

This is a Phase 2 optimization (see below), not a prerequisite for the experiment.

### 4. Pi (badlogic) or other agent harness (rejected for Phase 1)

Using Pi's SDK or agent framework would provide a ready-made tool loop and multi-provider support. We are not using it: we are not building many pluggable tools or providers; a minimal agent loop and swappable LLM are straightforward to implement ourselves. Keeps dependencies and complexity low for the experiment.

### 5. Pre-built intent shortcuts (optional later)

Deterministic pipelines for common patterns (`zmail news`, `zmail spending`, `zmail flights`) could be added as optimizations. Not required for Phase 1; the internal agent loop handles arbitrary questions first.

---

## Phasing

### Phase 1: Validate the architecture (the experiment)

**Goal:** Re-run the same bakeoff questions with `zmail ask`. Achieve **at least 50% latency improvement vs Google MCP** (e.g. ~50s → ~25s). Prove that a faster/smaller LLM plus a purpose-built internal tool interface can beat the current multi-round, high-tool-count approach.

**Scope:**
- `zmail ask <question>` CLI command (only external interface for the prototype)
- Internal micro-agent loop: fast LLM (e.g. GPT-4.1 mini) with tool-calling; no hardcoded pipeline
- Purpose-built internal tools: email-native, information-dense (search, get_messages, who, get_thread as needed)
- Streaming answer to stdout; optional timing/metadata for bakeoff comparison
- Swappable LLM provider kept simple (no Pi or external harness)

**Success criteria:**
- Same bakeoff questions as before; wall clock **≥50% lower than Google MCP** (e.g. ≤25s where Gmail was ~50s)
- Answer quality acceptable (good enough to trust for the tested questions)
- Room for further improvement (e.g. tuning tools, context, or model) without redesign

**Non-goals for Phase 1:**
- MCP `ask_email` or any external agent interface (defer until CLI validates)
- Rule-based intent shortcuts (add later if useful)
- Semantic search / embeddings
- Production-grade error handling or polish

### Phase 2: External interface + tuning

- Expose `ask` as MCP tool or other agent interface if desired
- Add rule-based shortcuts for high-frequency patterns if data supports it
- Tune internal tools and prompts based on Phase 1 usage
- Decide strategy for primitive tools (keep alongside ask, or make ask the default)

### Phase 3: Semantic search (if needed)

- sqlite-vec for embeddings in SQLite; local or index-time embeddings
- Only if Phase 1/2 show FTS + tool loop insufficient for some query types

---

## Tradeoffs and Risks

### Benefits

- **Target: ≥50% latency improvement vs Google MCP** on same bakeoff questions (e.g. ~50s → ~25s), with room to go lower
- **CLI-first** — validate without building MCP or agent UI; external interface comes later
- **Model control** — zmail uses a fast/cheap model for the task; no dependency on a heavy orchestrator (Opus, etc.)
- **Purpose-built internal tools** — email-native, information-dense; not a generic tool library
- **Streaming** — answers appear progressively

### Risks

- **API key dependency** — `ask` requires an LLM key (e.g. `ZMAIL_OPENAI_API_KEY`). Mitigatable with swappable providers or local models later.
- **Answer quality ceiling** — fast/small models may be worse than frontier models at synthesis; the bet is they are good enough for email Q&A over pre-selected content.
- **Transparency** — user sees the answer, not the internal tool calls. Can expose sources/metadata when we add an external interface.
- **Two interfaces eventually** — primitive tools (search, read, who) vs answer engine. Phase 1 only builds ask; strategy for coexistence decided in Phase 2.

### Open questions

- **Cost per query:** GPT-4.1 mini ~$0.003/query at typical usage; acceptable. Worth tracking.
- **Local model viability:** Could a local model (Llama 3 8B, Phi-3) give acceptable quality at target latency? Would remove API dependency. Phase 2.
- **Positioning:** zmail may evolve from "tool library for agents" toward "the agent that manages my email." UI/agent interface deferred; we validate speed and quality first.

---

## Relationship to Other Work

| Item | Impact |
|------|--------|
| **OPP-018** (reduce round-trips) | **Archived** (phase 1 done). [archive/OPP-018-reduce-agent-round-trips.md](archive/OPP-018-reduce-agent-round-trips.md) — richer search + batch read still help the answer engine's internal pipeline. |
| **OPP-019** (FTS-first) | Confirmed and reinforced. The answer engine uses FTS for retrieval. Semantic search deferred to Phase 3. |
| **OPP-002** (local embeddings) | Deferred. If semantic is reintroduced, sqlite-vec + local model is the path, not the prior LanceDB approach. |
| **BUG-016** (exhaustive search) | Still relevant — the answer engine's spending/receipt intents need exhaustive `from:` queries. Domain auto-routing fix benefits both architectures. |
| **STRATEGY.md** | May need updating. The answer engine shifts zmail from "queryable dataset for agents" toward "intelligent email assistant." The local-index moat argument still holds — the answer engine runs on the local index. |

---

## References

- Bakeoff performance data: [OPP-018](archive/OPP-018-reduce-agent-round-trips.md) (archived), BUG-016 (same questions to be re-run for Phase 1 validation)
- FTS-first decision: OPP-019
- STRATEGY.md — competitive positioning
- VISION.md — "just works in the agent" user promise
- Prior art: Perplexity (search → synthesize), Phind (code search → answer), RAG pipelines generally
- Pi (badlogic) coding agent: considered for agent loop; not used for Phase 1 (minimal loop, easy provider swap)
