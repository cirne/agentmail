# Experiment: Plan → Scatter → Assemble → Synthesize

**Branch:** `feature/plan-scatter-search`  
**Date:** March 2026  
**Status:** Completed — evals passing 8/8, architectural questions remain open

---

## Background

The `zmail ask` command existed on `main` as a two-phase pipeline:

1. **Phase 1 (Investigation):** Nano runs in an agentic tool-call loop (up to `MAX_TRIES = 5`), using `search`, `get_message`, and `get_thread_headers` tools to explore the email index. It guesses what to search for, sees results, and guesses again. The output is a set of candidate `messageId`s.
2. **Context Assembly:** Full bodies and attachments are fetched for all candidates.
3. **Phase 2 (Synthesis):** Mini produces a natural language answer from the assembled context.

Total observed latency: **4–12s** (vs. 74s for OpenAI + Gmail MCP in a bakeoff).

The investigation loop worked but had serious structural problems that accumulated over time:
- 350+ lines of retry and recovery scaffolding (`consecutiveFilteredFailures` counter, `includeNoise` retry loop, "prompting to try broader searches" injected user messages)
- **BUG-020:** Nano routinely put `apple.com` in the `query` parameter instead of `fromAddress`, causing domain-filtered searches to miss everything
- The LLM was making retrieval decisions that a few lines of code could make better and faster
- Each Nano round was ~300ms, and it often needed 3–5 rounds just to find what it was looking for

The motivating insight: **the local SQLite index is fast enough that all searches could execute in <50ms if we ran them upfront**. We were spending hundreds of milliseconds in LLM rounds to make decisions that are deterministic once you understand the query.

---

## The Experiment: What We Built

### New Architecture

Replace the iterative investigation loop with a fixed 4-step pipeline where only steps 1 and 4 touch an LLM:

```
Question
  ↓
Planner (Nano, JSON output, ~300ms)
  ↓ SearchPlan { patterns[], fromAddress?, afterDate?, ... }
Scatter (pure code, Promise.all, ~50ms)
  ↓ SearchResult[] (deduplicated, best rank preserved)
Assemble (pure code, tiered context, ~100ms)
  ↓ string (up to 80k chars, tiered by relevance)
Synthesize (Nano, streaming, ~500ms-1s)
  ↓
Answer
```

**Total target: 1.5–3s.** The LLM no longer makes retrieval decisions — it makes one planning decision upfront.

### New Files

| File | Role |
|------|------|
| `src/ask/planner.ts` | Single Nano call with `response_format: json_object`. Produces a `SearchPlan` with keyword patterns, optional `fromAddress`/`toAddress`, optional date range, and `includeNoise` flag. Has a keyword-split fallback if JSON parsing fails. |
| `src/ask/scatter.ts` | Runs all patterns in parallel via `Promise.all`. Adds a filter-only search when `fromAddress` is set (to catch messages from that domain that don't keyword-match). Deduplicates by `messageId`, preserving the best FTS5 rank. |
| `src/ask/assemble.ts` | Tiered context assembly: Tier 1 (subject match or strong FTS rank) gets up to 3000 chars; Tier 2 (any FTS match) gets 800 chars; Tier 3 (filter-only match) gets a 150-char snippet. 80k char hard cap. Attachment extraction preserved from v1. |
| `src/ask/planner.test.ts` | Unit tests with mocked OpenAI. Covers person queries, domain/vendor queries, news queries, date-range queries, fallback on JSON failure, API error handling. |
| `src/ask/scatter.test.ts` | Unit tests against real in-memory SQLite. Covers parallel dedup, filter-only search, `includeNoise` passthrough, date filter passthrough, empty pattern handling. |
| `src/ask/agent-v1.ts` | The original `agent.ts` preserved verbatim for A/B comparison. |

### Schema Changes (`src/db/schema.ts`)

The experiment revealed that FTS5 couldn't search `from_address` because it was marked `UNINDEXED`. We changed the schema significantly:

| Change | Why |
|--------|-----|
| `from_address` removed from `UNINDEXED` | So "apple.com" in a pattern hits messages from Apple in FTS5 |
| `from_name` added to FTS5 | Search by sender name ("marcio") now matches from_name column directly |
| `attachment_text` new FTS5 column | Aggregated `extracted_text` from all attachments, kept in sync by new triggers |
| New triggers on `attachments` table | Keep `attachment_text` in sync when attachment extraction runs |
| `SCHEMA_VERSION` bumped 9 → 12 | Three schema bumps through the experiment |

This makes the FTS5 index genuinely grep-like: a single pattern search now covers subject, body, sender address, sender name, and all attachment text simultaneously.

---

## What We Learned

### 1. The Planner Works — But the Prompt Is Critical

The planner as a concept works well. One Nano call with JSON output mode reliably produces a structured search plan in ~300ms. The format is clean and testable.

However, **the prompt is where all the intelligence lives**, and getting it right took multiple iterations:

- **Wrong rule, round 1:** Initial prompt said "use patterns only for vendor queries; FTS5 searches from_address automatically." This was wrong on two levels — FTS5 tokenizes dots so `apple.com` isn't a token boundary, and the prompt's own instruction confused the planner.
- **Wrong rule, round 2:** After fixing FTS5 indexing, we updated the prompt to use `fromAddress` as a "first-class structured filter." This is the right mental model: patterns are FTS5 keywords (content), `fromAddress`/date are SQL filters (metadata).
- **US date parsing gap:** The prompt had to explicitly teach the planner to convert `"1/1/26"` → `"2026-01-01"`. Without examples, Nano left it as a relative string.
- **Brand-to-domain mapping:** Had to provide explicit examples in the prompt: `Apple → apple.com`, `Amazon → amazon.com`, etc. Without examples, the planner would use "apple" as a pattern and miss the domain filter.

The planner prompt is now ~100 lines with examples. That's fine for a purpose-built tool, but it means any change to retrieval behavior requires careful prompt engineering.

### 2. We Found a Silent Date Bug in Scatter

The biggest bug discovered: **relative date strings (`"30d"`, `"7d"`) were passed raw to SQL**.

In `searchWithMeta`, `afterDate` flows directly to `m.date >= ?`. Real message dates are ISO strings like `"2026-02-09T..."`. SQLite string comparison: `"2026-02-09T..." >= "30d"` is `false` because `"2" < "3"` in ASCII. **Every date-filtered query was silently returning zero results.**

This explained why the apple.com spending query (which used `afterDate: "30d"`) consistently failed — not a model capability problem, a silent data bug. Fixed by adding a `resolveDate()` function in `scatter.ts` that converts relative strings to ISO dates before they hit SQL.

**Takeaway:** Silent zero-result failures are the hardest bug class in retrieval systems. The model confidently says "I didn't find anything" when really the query was broken. Verbose logging (`--verbose`) is essential for diagnosing these.

### 3. Nano Is Sufficient for Synthesis (Mini Is Overkill)

We switched the synthesis step from Mini → Nano mid-experiment. Quality held up: the Marcio Nunes answer (the most qualitative test) scored 0.80-0.90 on both models. Nano's synthesis was notably good:

> *"Marcio Nunes is the CEO and Founder of Harmonee AI, an early-stage company building an AI-driven platform tailored for on-premise environments such as government agencies and hospitals..."*

That's a complete, accurate synthesis from email context. Mini adds cost and latency without meaningful quality improvement for email Q&A synthesis. The quality difference between the models shows up in complex reasoning tasks, not in "summarize these emails."

**Current stack:** Nano for planning + Nano for synthesis. Both calls are cheap and fast.

### 4. The "Too Many Hits" Problem Is Real

Against a real inbox (not fixtures), a query like `"list all apple purchases since 1/1/26"` returned **282 unique messages** after scatter. The 80k char cap was hit after including only 36 of them. The other 246 messages weren't in the context.

This happens because:
- Without date filtering working (the bug described above), every message mentioning "apple" or "purchase" or "list" was returned
- Even with date filtering, "purchase" is a broad pattern that matches many non-Apple emails

Coding agents handle this by **observing intermediate results** — if grep returns 500 files, they look at directory distribution and narrow. Our pipeline doesn't observe; it commits to the plan upfront and truncates at the cap.

The planner's domain routing (`fromAddress: "apple.com"`) is the main mitigation — it makes the filter-only search precise. But it only helps if the planner gets it right, which depends on the prompt examples being complete enough.

### 5. One-Shot Is Faster But More Brittle Than Agentic

The fundamental tradeoff we kept returning to:

**One-shot (this branch):** The planner commits to a search plan in one call. If the plan is wrong — wrong domain, wrong date, wrong keywords — the answer will be wrong with no recovery. Users will notice immediately when it fails on something they know about.

**Agentic (v1):** The model can observe intermediate results and adjust. If the first search misses, it can try different terms. But this required 350+ lines of recovery scaffolding, and it still missed (BUG-020 survived multiple iterations).

The v1 scaffolding was essentially building a finite state machine to approximate the agentic behavior we wanted — "if 0 results, try without filters; if still 0, try with includeNoise" — but doing it with explicit rules rather than letting the model decide. That's the worst of both worlds.

**The key insight from later in the conversation:** Tool latency is <5% of wall clock time. A 4-call agentic loop over local SQLite costs ~4 × 300ms LLM + noise = ~1.2s, not 4-12s. The latency isn't the tool calls — it's the LLM rounds. A purpose-built agent that needs 2-3 LLM calls (vs. 5-8 for a general agent) can still be dramatically faster than Claude+Gmail MCP while being more adaptive than one-shot.

---

## Eval Results

### Starting State (v1 on main)

Evals used in this experiment: 8 total (6 standard + 2 edge cases added during experiment).

### Progression on This Branch

| Phase | Passing | Notable Failures |
|-------|---------|-----------------|
| Initial implementation | 3/8 | FTS5 syntax error on empty patterns, date bug, BUG-020 |
| After FTS5 empty-pattern fix | 5/8 | Date bug, BUG-020 |
| After date bug fix + prompt fix | 8/8 | — |
| After vendor-mapping + US date examples | 8/8 (stable) | Occasional LLM judge variance on Marcio |

**All 8 evals currently pass.** Observed latency: 4–10s on eval fixtures (lower than v1's 4–12s for the investigation phase alone; real-world numbers vary with inbox size).

**BUG-020 is resolved** — the planner prompt now explicitly teaches domain-to-`fromAddress` routing with brand examples, and the date bug fix means date-filtered searches actually filter.

---

## Current State vs. Main

| Dimension | `main` (v1) | `feature/plan-scatter-search` (v2) |
|-----------|-------------|-------------------------------------|
| LLM calls | 2–7 (Nano investigation loop + Mini synthesis) | 2 (Nano planner + Nano synthesis) |
| Retrieval | LLM tool calls, iterative | Code, parallel, deterministic |
| Latency (target) | 4–12s | 1.5–3s (measured 4-10s on evals, likely faster on simpler queries) |
| Recovery from bad plan | Retry scaffolding (350+ lines) | None — one-shot |
| FTS5 index | subject + body_text | subject + body_text + from_address + from_name + attachment_text |
| Schema version | 9 | 12 |
| Evals passing | baseline | 8/8 |
| Code complexity | ~600 lines in agent.ts | ~400 lines split across 4 files |
| Testability | Hard (Nano tool calls) | Easy (each step unit-testable) |

---

## Open Questions

The branch is in a good state — evals pass, the architecture is cleaner, the schema improvement (indexing everything) is valuable regardless of which pipeline wins. But some questions were unresolved:

1. **Is one-shot fragile enough to matter?** On eval fixtures it's fine. On a real inbox with surprising queries ("what was the issue with my subscription?"), will the planner reliably produce good plans without examples that specifically cover that query shape?

2. **Should the pipeline observe intermediate results?** If scatter returns 300 hits and only 36 fit in context, the current pipeline just truncates. A smarter pipeline would notice this and either narrow the plan (re-planning) or do a second-pass ranking on the hits before assembly. This is the "coding agent loop" pattern.

3. **Mini vs. Nano for synthesis — does it matter for complex questions?** For synthesis-heavy queries (long threads, many emails, extract-and-compare tasks), Nano may miss things Mini would catch. We didn't test this boundary.

4. **Agentic loop with 2–3 LLM rounds might be the right answer.** The insight that tool latency is <5% of wall clock means an agentic loop that: (a) runs an initial scatter, (b) observes hit density and distribution, (c) optionally narrows and re-scatters before assembly — could achieve both accuracy and speed without needing 500 lines of manual recovery logic.

---

## Recommendation

**Merge the schema changes to main regardless of pipeline decision.** The expanded FTS5 index (from_address, from_name, attachment_text) is a clear improvement that benefits both v1 and v2.

**Use v2 as the base for further experimentation.** The 4-step pipeline is cleaner, more testable, and the architecture is correct. The open questions are about robustness of the one-shot planner, which is easier to experiment on from this base than from the v1 loop.

**If building toward production:** The planner needs to be more robust to query variety before one-shot is reliable. Either enrich the prompt further with more examples, or add a lightweight "observe and re-plan" step after scatter (still only 3 LLM calls total, but adaptive).

---

## See Also

- [`docs/ASK.md`](ASK.md) — public-facing documentation for `zmail ask` (describes v1 architecture; should be updated if v2 ships)
- [`src/ask/agent-v1.ts`](../src/ask/agent-v1.ts) — original investigation loop, preserved for comparison
- [OPP-020](opportunities/archive/OPP-020-answer-engine-local-agent.md) — original opportunity that motivated `zmail ask`
