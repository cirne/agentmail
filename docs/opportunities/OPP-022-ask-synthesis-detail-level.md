# OPP-022: Ask Synthesis — Default Detail Level Too Shallow for Broad Queries

**Problem:** When `zmail ask` receives a broad synthesis query (e.g. "look at all emails from X about Y and synthesize into a summary — there have been many changes and drafts"), the GPT-4.1 mini synthesis step returns a high-level overview (~150 words) that omits the specific details the user needs. The data is available in the assembled context — mini just chooses not to surface it.

**Example:**

Query: `zmail ask "look at all of the emails from kirsten about summer travel plans, hotel reservations etc and synthesize into a summary. there have been many changes and drafts"`

**What ask returned:** A paragraph-level overview: parks mentioned, general date range, who's managing reservations. ~150 words.

**What the user needed (and got via follow-up calls):**
- The specific day-by-day itinerary (July 1-6 Monterey, July 6-8 Yosemite cabins, July 8-9 tent cabins, etc.)
- Calendar churn (AutoCamp Sequoia added then deleted 2x, Monarch Hotel added/deleted 3x then re-added)
- Date revisions (AutoCamp shifted from July 12-16 to July 12-15)
- Which plans appear current vs. cancelled

All of this was retrievable via follow-up `ask` calls with more specific prompts, proving the data was in context — mini just summarized it away.

**Root cause — the mini system prompt:**

The current GPT-4.1 mini system prompt (in `src/ask/agent.ts`, line ~569) is:

```
"You are an email assistant. Answer the user's question using only the provided email context.
Be concise; cite subject or sender when relevant. If you cannot find enough information in
the context, say so."
```

"Be concise" instructs the model to compress aggressively. For factual lookups ("who is X?", "what's my flight confirmation?") this is appropriate. For synthesis queries that span many emails with revisions and changes, it discards exactly the details the user asked for.

---

## Proposed direction

Tune the mini system prompt to produce **appropriately detailed** responses — concise for simple lookups, thorough for broad synthesis. The goal: one well-scoped `ask` call should return what currently takes 3 follow-up calls.

### Approach 1: Query-aware prompt (recommended)

Detect synthesis signals in the query (keywords like "summarize", "synthesize", "changes", "drafts", "all emails from", "itinerary", "timeline") and adjust the mini prompt accordingly:

- **Simple/factual queries** ("who is X?", "what time is my flight?"): Keep "be concise"
- **Synthesis queries** ("summarize all emails about Y", "what changed across drafts?"): Switch to a prompt that instructs the model to:
  1. Surface specific details (dates, locations, names, amounts) rather than summarizing them away
  2. Call out what changed between drafts/revisions when the query mentions changes
  3. Distinguish current state from cancelled/superseded plans
  4. Err on the side of more detail when the query scope is broad
  5. Use structured formatting (bullet points, sections, timeline) for multi-email synthesis

Example prompt for synthesis mode:
```
"You are an email assistant. Answer the user's question using only the provided email context.
Be thorough and specific — surface concrete details (dates, locations, names, amounts) rather
than summarizing them away. When multiple emails show revisions or changes, call out what
changed and distinguish current plans from cancelled/superseded ones. Use structured formatting
(sections, bullets, timeline) when synthesizing across many emails. Cite subject or sender
when relevant."
```

### Approach 2: Always-detailed prompt (simpler, may over-generate for simple queries)

Replace "Be concise" with "Be thorough" universally. Risk: simple queries ("what time is my meeting?") get unnecessarily long responses. Could be mitigated with a follow-up instruction like "Match your response length to the complexity of the question."

### Approach 3: Prompt with adaptive length instruction

A single prompt that instructs the model to calibrate detail level to the query:

```
"Match your response length and detail to the complexity of the question. For simple factual
queries, be concise. For broad synthesis across many emails, be thorough — surface specific
details, call out changes between drafts, and distinguish current state from superseded plans."
```

---

## Impact

In the reported session, the shallow default caused:
- 2 additional `ask` calls to get the details that should have been in the first response
- 4 `search` calls attempting the manual read path (which also failed due to the `read` bug — see BUG-021)
- ~4 extra minutes of wall time
- A worse user experience (had to explicitly ask for details that should have been in the first response)

For agent workflows, each extra round-trip adds latency (15-25s per outer LLM round) and context window cost. The entire value proposition of `zmail ask` (see OPP-020) is to deliver a complete answer in one call.

---

## Open questions

- **Threshold for "synthesis mode":** How to detect when a query needs more detail? Keyword-based heuristic vs. letting nano annotate the query intent during Phase 1?
- **Max response length:** Should we set a `max_tokens` ceiling for mini, or let the model self-regulate based on prompt instructions?
- **Eval coverage:** Need eval cases for synthesis queries to ensure the prompt change doesn't regress simple lookups. Consider adding the Kirsten travel query as an eval case.
- **Temperature:** Currently using mini's default temperature. A slightly higher temperature might produce more expansive responses; worth testing.

---

## References

- Ask pipeline: `src/ask/agent.ts` (mini system prompt at line ~569)
- Answer engine architecture: [OPP-020](OPP-020-answer-engine-local-agent.md)
- Round-trip reduction: [OPP-018](OPP-018-reduce-agent-round-trips.md)
- Read bug (blocks manual follow-up path): [BUG-021](../bugs/BUG-021-read-prepare-error.md)
- Ask documentation: [docs/ASK.md](../ASK.md)
