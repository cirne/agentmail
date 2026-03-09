# BUG-016: Bakeoff Failure — Incomplete Coverage vs Google Adapter — Agent-Reported

**Status:** Open. **Updated:** 2026-03-09 (eval test failure confirms issue persists). **Tags:** semantic, eval

**Design lens:** [Agent-first](../../VISION.md) — For transactional queries requiring complete coverage (financial, legal, compliance), zmail must return all matching results. Missing half the data makes it unsuitable for critical workflows, regardless of search speed advantage.

**Reported context:**
- **Initial bakeoff (2026-03-07):** "summarize my spending on apple.com in the last 30 days". zmail found 18 receipts ($808) vs Gmail 36 receipts ($1,762). zmail hit FTS5 crash on "apple.com" query; agent improvised workarounds.
- **Post-fix retest (2026-03-07):** After truncation + FTS5 fixes, zmail found only **9 of 37 receipts** (worse than before). Gmail 36 of 37. FTS5 "fix" inadvertently made querying more restrictive.
- **Eval test failure (2026-03-09):** Eval test case "summarize my spending on apple.com in the last 30 days" scored 0.50/1.0 (required: 0.70+). Answer stated "The provided emails do not contain detailed information" despite 22 Apple receipts ($1,387.80) existing in test fixtures within date range. Judge reasoning: "lacks a comprehensive summary of total spending and does not clearly address the question." Confirms search/aggregation issues persist in eval environment with realistic fixtures.

---

## Summary

zmail loses this bakeoff due to multiple compounding problems in the search stack. The initial failure was silent truncation + FTS5 crash. The post-fix regression to 9 results revealed a more fundamental issue: **"apple.com" is a domain query that should route to `from:` filter, but instead gets mangled into a restrictive FTS5 phrase match**. The result is fewer receipts found after the "fix" than before.

There are five distinct bugs here, each contributing to the failure.

---

## What the agent did (and what happened)

### Initial Bakeoff (2026-03-07)

**Query:** "summarize my spending on apple.com in the last 30 days"

| | zmail | Gmail |
|---|---|---|
| Receipts found | 18 | 36 |
| Total spend | $808 | $1,762 |
| Tool calls | 11 | 29 |
| Agent duration | 253s | 88s |

zmail crashed on `zmail search "apple.com"` with FTS5 syntax error. The agent improvised 11 tool calls using alternate queries ("apple receipt", `from:` combinations, etc.) and found 18. Gmail's exact-match mailbox search found 36 without effort.

### Post-Fix Retest (2026-03-07)

After implementing fixes (limit 20→50, FTS5 dot escaping, totalMatched count):

| | zmail | Gmail |
|---|---|---|
| Receipts found | **9** (worse) | 36 |

FTS5 fix confirmed working. But results got **worse** — from 18 to 9. The FTS5 "fix" introduced a regression (see Root Cause 1 below). Also observed: `returned=50, totalMatched=41` (logically impossible — returned exceeds total matched).

---

## Deep Root Cause Analysis

### Bug 1: FTS5 phrase-quote makes "apple.com" MORE restrictive, not less (causes the regression)

`escapeFts5Query("apple.com")` wraps the query in double quotes: `'"apple.com"'`. In FTS5, double-quoted strings are **phrase searches** — they require the tokens to appear adjacent in that exact order.

FTS5's unicode61 tokenizer splits on dots, so `apple.com` in email body text becomes tokens `[apple, com]`. A phrase search `"apple.com"` requires these two tokens to appear **adjacent** — which matches the literal string "apple.com" in body text, but **not** emails that just say "Apple" or "Apple Store" or "Apple ID" in the subject.

Apple receipt emails typically have subjects like `"Your receipt from Apple"` — which FTS5 indexes as token `apple` but NOT adjacent to `com`. The phrase match **misses all of these**.

**Why results got worse (18 → 9):**
- **Before fix:** FTS5 crashed on "apple.com" → agent fell back to queries like "apple receipt" → FTS5 tokenized as `apple` AND `receipt` separately → matched many receipts → 18 found
- **After fix:** FTS5 works on "apple.com" → phrase match `"apple.com"` only matches emails containing the URL literal → misses receipts with subject "Your receipt from Apple" → fewer FTS matches → 9 found total

The fix traded a crash for a silently worse result. Both are wrong.

**Correct fix for this specific issue:** Detect domain-name patterns (`word.tld`) and route to a `from:` filter instead of a phrase search. The query "apple.com" semantically means "emails from apple.com" — not "emails containing the literal string apple.com".

```
"apple.com" → from:apple.com (LIKE '%apple.com%' on from_address)
```

This is what Gmail does natively: their search interprets domain patterns as sender filters.

---

### Bug 2: Double-truncation in hybrid search — results dropped at every step

Tracing the hybrid search execution with `limit=50`:

```
FTS search:
  → asks DB for (50+0+50)=100 rows, BM25-ranked
  → slices to first 50 → ftsResults (50 items max)
  → ftsTotalCount = COUNT(*) = 41 (actual FTS matches)

Semantic search:
  → asks LanceDB for (50+0+50)=100 nearest neighbors
  → filters by score >= 0.45
  → slices to first 50 → semanticResults (50 items max)

Merge (RRF):
  → combined = union(ftsResults, semanticResults) — up to 100 unique
  → sorted by RRF score
  → .slice(0, 50) → final results (50 items max)
```

The problem: Apple receipts are **semantically homogeneous** (they all say "Your receipt from Apple" with an amount). LanceDB returns them in arbitrary order within the nearest-neighbor set. Some receipts land at position 40 in LanceDB results, some at position 60+. Those beyond position 50 in semantic results are discarded before the merge, so they never appear in the final output even if they're highly relevant.

After the merge, the RRF sort further filters to 50. Even if a receipt survived semantic truncation, it competes with all other combined results for the top 50 slots.

With 37 Apple receipts and limit=50:
- FTS might rank 20-25 of them in its top 50
- Semantic might rank 15-20 of them in its top 50 (different subset)
- After merge and final slice: only those in the combined top 50 by RRF survive
- Result: ~9 in the overlapping high-RRF region

**Why `from:no_reply@email.apple.com` finds all 46:** That routes to `filterOnlySearch` (no FTS, no semantic), which does a SQL LIKE match with `LIMIT 50 OFFSET 0`. All 46 are returned because it's exhaustive SQL, not relevance-ranked.

---

### Bug 3: `totalMatched` is logically inconsistent for hybrid search

Current code: `totalMatched = ftsTotalCount` (the FTS COUNT(*) result).

Observed: `returned=50, totalMatched=41` — returned **exceeds** totalMatched, which is impossible by definition. An agent reading this will be confused and may distrust all metadata.

**Why it happens:** FTS finds 41 documents matching the query. Semantic search finds additional documents that aren't in FTS (semantic-only matches). The merged set has 50 unique documents. But `totalMatched` is still reported as 41 (FTS-only count).

**Correct fix:** `totalMatched` should be `combined.size` — the deduplicated union of all FTS + semantic results, before the final `slice(offset, offset + limit)`. This is the actual number of documents the search engine considers "matched."

---

### Bug 4: Semantic score threshold is wrong for homogeneous transactional corpora

`SEMANTIC_SCORE_THRESHOLD = 0.45` where `score = 1 / (1 + cosine_distance)`.

For LanceDB cosine distance (range [0, 2]):
- `score = 0.45` → `cosine_distance = 1.22` → `cosine_similarity = -0.22`

That's a **negative** cosine similarity threshold — meaning we include embeddings that are slightly anti-correlated with the query. In practice this means almost nothing is filtered out. The threshold is effectively useless for discrimination.

The deeper problem: Apple receipts are all nearly identical embeddings (same sender, same template, same amount format). When searching "apple spending", their cosine similarity to the query may be moderate (0.3–0.6 cosine_similarity = distances 0.4–0.7 = scores 0.59–0.71). All 37 receipts would be very close to each other in embedding space. LanceDB's ANN search returns the top-N nearest, which should include all 37 if we request 100 results.

The real issue isn't the threshold — it's that we only ever ask LanceDB for `limit + offset + 50 = 100` results. If the 37 receipts are scattered from position 1 to 37 in LanceDB's nearest-neighbor ranking, they should all make it through. But if other non-receipt emails score similarly (e.g., emails mentioning "spending" with Apple devices, Apple stock, etc.), they can crowd out receipts beyond position 100.

---

### Bug 5: No guidance for exhaustive enumeration queries

This is the architectural issue underlying all of the above. There are two fundamentally different query intents:

1. **Relevance search** ("what did dan suggest for cabo?") — find the best matching document among millions; top-N is fine; FTS+semantic is the right tool
2. **Exhaustive enumeration** ("summarize my spending on apple.com") — find ALL documents matching a criterion; correctness requires 100% recall; SQL filter is the right tool

zmail uses relevance search for both cases. Gmail implicitly uses exhaustive enumeration (mailbox scan with filters) for the second. This is why Gmail wins decisively on transactional queries — it's not using a smarter search algorithm, it's using the right tool for the job.

Agents searching for "apple.com spending" need an exhaustive path. They don't have one today. The `from:` operator provides it, but agents have to discover the exact sender address (`no_reply@email.apple.com`) before they can use it — which requires knowing the answer before asking the question.

---

## What a Real Fix Looks Like

The bugs above have concrete fixes at each layer:

### Fix 1: Domain-name query auto-routing (highest impact)

Detect domain patterns in queries and rewrite to `from:` filter:

```typescript
// In parseSearchQuery or searchWithMeta
function detectDomainQuery(query: string): { domain: string; remainder: string } | null {
  // Match word.tld patterns like "apple.com", "amazon.com", "stripe.com"
  const match = query.match(/\b([a-z0-9-]+\.[a-z]{2,})\b/i);
  if (match) {
    return {
      domain: match[1],
      remainder: query.replace(match[0], '').trim(),
    };
  }
  return null;
}

// In searchWithMeta:
const domainQuery = detectDomainQuery(parsedQuery);
if (domainQuery && !effectiveOpts.fromAddress) {
  effectiveOpts.fromAddress = domainQuery.domain;
  effectiveOpts.query = domainQuery.remainder;
}
```

With this, `"apple.com spending"` → `from:apple.com` + `"spending"` in FTS. The `from:` filter is applied as a SQL LIKE on `from_address`, which is exhaustive regardless of how many results there are.

### Fix 2: Sender-cluster hint in search results

When all (or most) returned results share the same `fromAddress`, add a hint:

```typescript
const senderCounts = new Map<string, number>();
for (const r of results) senderCounts.set(r.fromAddress, (senderCounts.get(r.fromAddress) ?? 0) + 1);
const dominantSender = [...senderCounts.entries()].find(([, n]) => n > results.length * 0.7);
if (dominantSender && totalMatched > results.length) {
  hint = `All results from ${dominantSender[0]}. Use from:${dominantSender[0]} for exhaustive results.`;
}
```

This gives agents the `from:` operator they need without requiring them to know the sender address in advance.

### Fix 3: Correct `totalMatched` for hybrid search

```typescript
// After building combined map, before slicing:
const totalCombined = combined.size; // true count of all unique matches

// In return:
return {
  results: sorted.map(...),
  timings,
  totalMatched: totalCombined, // NOT ftsTotalCount
  ...
};
```

This eliminates the `returned > totalMatched` impossibility.

### Fix 4: Don't double-truncate in hybrid — fetch more, merge all, slice once

Currently: FTS slices to `limit`, semantic slices to `limit`, then merge slices to `limit` again. Should be:

```typescript
// Fetch generously from both (e.g., limit * 3 or a fixed high number)
const FETCH_MULTIPLIER = 3;
const fetchLimit = limit * FETCH_MULTIPLIER;

const ftsResults = ftsSearch(db, { ...effectiveOpts, limit: fetchLimit });
const semanticResults = await vectorSearch(db, { ...effectiveOpts, limit: fetchLimit });

// Merge all, RRF score, then slice ONCE
const combined = merge(ftsResults.results, semanticResults.results);
const sorted = [...combined.values()].sort(byRrf).slice(offset, offset + limit);
```

This ensures a receipt at FTS position 48 and semantic position 62 both make it into the merge pool, instead of being truncated before they can benefit each other.

---

## Impact

**Critical for agent workflows.** Post-fix, zmail finds 9 of 37 Apple receipts (75% miss rate) — worse than pre-fix 18 of 36 (50% miss rate). The FTS5 fix inadvertently made a bad situation worse by introducing phrase-match restrictions.

**Structural disadvantage:** zmail's hybrid relevance search is architecturally wrong for exhaustive enumeration queries. Gmail wins not by being smarter, but by using SQL filters that guarantee 100% recall. Until zmail auto-routes domain/sender queries to exhaustive SQL filters, it will lose every bakeoff against Gmail on transactional queries.

---

## References

- Vision (agent-first): [VISION.md](../../VISION.md)
- Initial bakeoff: `../ztest/feedback/submitted/bakeoff-results.md`
- Post-fix retest with new issues: `../ztest/feedback/submitted/bug-search-silent-truncation-and-fts-dot-syntax.md` (lines 86–118)
- Relevant code: `src/search/index.ts` — `escapeFts5Query`, `ftsSearch`, `vectorSearchFromEmbedding`, `searchWithMeta`

## Update History

- **2026-03-07 (initial):** Created — 18 vs 36 receipts (50% miss), FTS5 crash, silent truncation
- **2026-03-07 (post-fix retest):** Updated — truncation and FTS5 syntax fixed, but results worsened to 9 vs 37 (75% miss)
- **2026-03-07 (deep analysis):** Full root cause analysis added — 5 distinct bugs identified; FTS5 phrase-quote is the regression cause; domain auto-routing to `from:` is the primary fix
- **2026-03-09 (eval test failure):** Eval test case confirms issue persists — scored 0.50/1.0 (required 0.70+). Answer stated "no detailed information" despite 22 Apple receipts ($1,387.80) existing in test fixtures. Judge: "lacks comprehensive summary of total spending." Confirms search/aggregation issues affect answer quality in eval environment with realistic fixtures (525 messages, 81 Apple messages in last 30 days).
