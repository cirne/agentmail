# OPP-018: Reduce Agent Round-Trips — Richer Search Output + Batch Reads

**Problem:** LLM thinking time is 91–99% of wall-clock in every bakeoff. zmail search itself is already fast (26–796ms). But each sequential tool call round costs 15–25s in LLM deliberation. The typical agent workflow is 3–4 rounds: search → read results → follow-up reads → synthesize. The #1 optimization is not faster search — it's fewer rounds.

Concrete measurements from Bakeoff #4 (tech news, 2026-03-07):

| Interface | Tool calls | Wall-clock | LLM % |
|-----------|-----------|-----------|-------|
| zmail CLI | 8 (12 tool uses) | 99s | 99% |
| zmail MCP | 11 (19 tool uses) | 96s | 97% |
| Gmail MCP | 13 tool uses | 74s | 91% |

Gmail won despite having more tool calls and slower individual calls, because its structured responses are **information-dense** — agents extract what they need faster and move to synthesis sooner.

**Example:** MCP agent made 5 sequential `get_message` calls to read 5 TLDR newsletters. Each call = one LLM round. A batch call would collapse that to 1 round, saving ~60s.

**Proposed direction:** Make each tool call return more actionable information so agents reach the synthesis step in fewer rounds. Target: 3–4 rounds → 1–2 rounds = 30–60s saved per query.

---

## Interventions (in priority order)

### 1. Body preview in every search result (highest impact)

Include a 200–300 character body snippet in every `search` / `search_mail` result by default — no extra flag, no extra call needed.

For newsletter emails (TLDR, The Information, Kara Swisher, etc.), return more: 500–1000 chars or the entire first section. Agents almost always read newsletters in full, so returning a preview inline eliminates a `get_message` call per newsletter.

**Current flow (3 rounds):**
1. `search "tech news"` → headers only → LLM decides which to read
2. `get_message <id1>`, `get_message <id2>`, ... → 4–5 calls, 4–5 LLM rounds
3. Synthesize

**Target flow (1–2 rounds):**
1. `search "tech news" --limit 10` → headers + 300-char snippets → LLM synthesizes directly for simple queries
2. (Optional) `get_message <id>` for one deeply relevant email → synthesize

**Implementation:**
- Add `snippet` field to search result rows (first 300 chars of body, stripped of HTML)
- Store precomputed snippet in SQLite at index time (avoids runtime text processing overhead)
- CLI: include snippet in default JSON/text output
- MCP: include snippet in `search_mail` results

### 2. MCP batch get_message

Accept an array of message IDs and return all bodies in one response:

```typescript
// Current (5 rounds):
get_message({ messageId: "abc" })
get_message({ messageId: "def" })
get_message({ messageId: "ghi" })
...

// Proposed (1 round):
get_messages({ messageIds: ["abc", "def", "ghi", "jkl", "mno"] })
// Returns array of { id, from, subject, date, body } objects
```

**Impact:** MCP agent in Bakeoff #4 made 5 sequential `get_message` calls. Batch → 1 call → save ~80s (4 eliminated LLM rounds × 20s each).

**Implementation:**
- Add `get_messages` tool to MCP server (`src/mcp/index.ts`)
- Accept `messageIds: string[]`, cap at 20 per call
- Return array in same format as `get_message` response
- Keep `get_message` (singular) for backward compatibility

### 3. Attachment indicators + inline summaries in search results

Currently, agents discovering attachments requires a follow-up `attachment list` call. Search results should include:

```json
{
  "subject": "Tienda 17 LLC - Financial Summary",
  "attachments": [
    { "filename": "financials.xlsx", "type": "xlsx", "index": 1 }
  ]
}
```

For highly-ranked results with attachments, optionally include a short extracted-text preview (first 200 chars of the extracted attachment) if already cached.

**Impact:** In Bakeoff #1, the winning move was reading the XLSX attachment. An agent seeing "financials.xlsx (xlsx)" in the search result can immediately call `attachment read` without a discovery round.

### 4. `--detail body` improvements (CLI)

The current `--detail body` flag returns a wall of mixed text that is harder for LLMs to parse. Improvements:

- Add `--detail body --format json` to return structured JSON with separate `body` field per result
- Add `--detail body --limit 5` to apply body hydration to only the top N results (currently applies to all)
- Add `--detail snippet` as a lighter option (300 chars per result, always JSON)

### 5. Newsletter detection + richer inline content

Detect newsletter-type emails (high signal: known newsletter senders like TLDR, The Information, Ground News; or heuristics like list-unsubscribe headers + high word count) and return more content for them by default.

In Bakeoff #3 and #4, agents always read newsletters in full — the snippet just tells them there's more. For newsletters, return the full text inline with search results when the result count is small (e.g., ≤ 5 newsletter matches).

---

## Expected outcomes

| Scenario | Current rounds | Target rounds | Time saved |
|----------|---------------|---------------|-----------|
| Tech news summarization | 3–4 | 1–2 | 30–50s |
| MCP reading 5 TLDR newsletters | 5 separate get_message calls | 1 batch call | ~60s |
| Finding an email + attachment data | search → attachment list → attachment read = 3 calls | search (shows attachment) → attachment read = 2 calls | ~15s |
| Simple person query | search → read thread = 2 rounds | search (with snippet) → done = 1 round | ~20s |

**Combined: zmail wall-clock target for tech news query: 99s → ~45s.** This would close the gap with Gmail (74s) and potentially beat it.

---

## Open questions

- Snippet storage: precompute at index time (adds ~300 bytes per email to SQLite) vs runtime extraction (adds ~5ms per result row). Index-time is better for query latency but requires a schema change and re-index for existing data. See [AGENTS.md](../../AGENTS.md) no-migrations policy — manual ALTER TABLE is the path.
- Newsletter detection threshold: false positives (treating a long personal email as a newsletter) would bloat response size. Use the presence of `List-Unsubscribe` header + sender domain heuristics to minimize false positives.
- MCP `get_messages` batch size cap: 20 is a reasonable starting point. Monitor token size of responses (20 full email bodies could exceed context).
- Should body snippets be on by default in MCP, or require a flag? Given that MCP is for agent use (agents always benefit from more context), on by default is correct.

---

## References

- Bakeoff analysis: `../ztest/feedback/submitted/bakeoff-004-tech-news.md` (primary source)
- Supporting data: `../ztest/feedback/submitted/bakeoff-001-rudy-funds.md`, `bakeoff-003-news-headlines.md`
- Related: [BUG-016](../bugs/BUG-016-bakeoff-incomplete-coverage-critical.md) — exhaustive search coverage
- Related: [BUG-017](../bugs/BUG-017-semantic-recall-gap-intent-queries.md) — semantic recall gap
- Related: [OPP-002](OPP-002-local-embeddings.md) — local embeddings (eliminates 500–800ms embedding round-trip)
- MCP server: `src/mcp/index.ts`
- CLI search: `src/cli/index.ts`
