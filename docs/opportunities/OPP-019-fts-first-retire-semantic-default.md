# OPP-019: FTS-First Architecture — Retire Semantic Search as Default

**Status:** Strategic decision — confirmed by empirical bakeoff testing (2026-03-07).

**Problem:** Semantic (vector) search was designed for the wrong user model. zmail was built with the assumption that *the search engine* must understand user intent — hence hybrid semantic+FTS as the default. But in an agent-first architecture, **the agent IS the semantic layer.** The agent converts vague user intent into concrete keyword queries before ever calling zmail. This makes built-in semantic search redundant at best, and actively harmful at worst.

**Example:** "who is that entrepreneur I met last week?" — In Bakeoff #2, semantic search completely missed Marcio Nunes. In the Bakeoff #5 rematch with FTS-only, agents naturally decomposed the query into `"meeting OR zoom OR call"` and `"entrepreneur OR startup OR founder"`, found Marcio immediately, and zmail MCP also surfaced a second entrepreneur Gmail missed. **Same data. FTS-only won.**

**User confirmation:** Tested across all bakeoff scenarios. Disabling vector search improved both wall-clock time and answer quality in every case.

---

## Why Semantic Search Hurts in Agent-First Design

### 1. The agent does semantic translation better than the search engine

When a capable agent receives "who is that entrepreneur I met?", it doesn't pass that string to zmail verbatim. It thinks: "I should look for Zoom invites, Otter.ai summaries, calendar emails, follow-ups from last week." It generates keyword-rich queries that FTS handles perfectly.

The search engine trying to do the same thing via embeddings is a worse version of reasoning the agent already does — with higher latency, less context, and no ability to adapt.

### 2. Semantic search fails on enumeration queries (BUG-016)

"Summarize my spending on apple.com" requires finding *all* matching emails. Semantic search returns the *most similar* results, ranked and truncated. Result: 9 of 37 Apple receipts found (75% miss rate). FTS with `from:` filter finds all of them. Semantic's relevance ranking is architecturally wrong for the most critical agent workflows.

### 3. Semantic search adds latency that dominates query cost

LLM thinking time is 91-99% of wall-clock. But within tool execution, embedding generation is 81-98% of search latency (499-778ms observed). Every search call carries this penalty whether or not it benefits from semantic understanding. FTS runs in 3-40ms.

### 4. Semantic search increases variance and unpredictability

FTS results are deterministic and explainable — agents can reason about *why* they got results. Semantic results depend on embedding quality, vector space proximity, and truncation thresholds. Agents can't predict or correct for these failures the way they can refine keyword queries.

### 5. Retiring semantic dramatically simplifies the entire system

This is worth dwelling on. Semantic search isn't just one feature — it's a complex subsystem that touches every layer:

**Sync:**
- Every synced email must be embedded (OpenAI API call per email, or batched)
- Embeddings must be stored in LanceDB (separate vector store, separate data directory)
- Failed/pending embeddings must be tracked (`embedding_state` column in SQLite)
- Re-indexing is required when switching embedding models or dimensions
- Background embedding backfill needed for emails synced before semantic was enabled

**Query path:**
- Every search incurs embedding generation (499–778ms observed)
- Two separate retrieval engines (FTS5 in SQLite + ANN in LanceDB) must be queried, results merged via RRF, then re-ranked and truncated
- The hybrid merge itself is a source of bugs (BUG-016: double-truncation, `returned > totalMatched` impossibility)

**Dependencies:**
- `OPENAI_API_KEY` required at setup — a hard barrier for new users and automated installs
- LanceDB npm package (~50MB), native bindings, platform-specific binaries
- Two separate data stores to back up, corrupt, or fall out of sync

**Retiring semantic removes all of this.** What remains: SQLite FTS5 — a battle-tested, zero-dependency, single-file full-text search engine that ships with SQLite. No API keys, no vector store, no embedding queue, no merge logic, no RRF. Just fast, reliable keyword search that agents are already better at driving than the embedding engine was.

---

## The Empirical Case: Bakeoff #5

Bakeoff #2 (semantic-default): zmail **missed Marcio Nunes entirely**. Gmail won.

Bakeoff #5 rematch (FTS-only — same query, same data):
- All three zmail interfaces found Marcio
- zmail MCP **beat Gmail** by also finding a second entrepreneur (Sarah Findlay)
- zmail was more token-efficient (23K vs Gmail's 44K tokens)

| | Bakeoff #2 (semantic default) | Bakeoff #5 (FTS only) |
|---|---|---|
| zmail found Marcio? | **No** | **Yes** |
| zmail beat Gmail? | No (Gmail won) | Yes (slight edge) |
| Key agent behavior | Passed vague query to semantic engine | Decomposed into keyword searches |

The critical insight from the agent transcript: when FTS was disabled, agents didn't give up — they crafted better queries. The agent's query decomposition capability is the semantic layer, not the search engine.

---

## Proposed Direction

### Immediate: Make FTS the default

`--fts` is already a flag that opts out of hybrid. The proposal: flip the default.

```
# Before: hybrid (FTS + semantic) is default
zmail search "entrepreneur meeting"  # →  hybrid

# After: FTS is default
zmail search "entrepreneur meeting"  # →  FTS only
zmail search "entrepreneur meeting" --semantic  # →  hybrid (opt-in)
```

For MCP: `search_mail` defaults to FTS. Add `semantic: true` parameter for opt-in hybrid.

### Medium term: Retire hybrid as a concept

After confirming FTS-first works across more scenarios, consider:
- Removing the `--fts` flag (no longer needed; FTS is just "search")
- Making semantic opt-in via explicit `--semantic` flag or MCP parameter
- Documenting when semantic is genuinely useful (see below)

### Retain semantic for the cases where it genuinely helps

There are narrow cases where semantic provides value that agents can't easily replicate with keyword decomposition:

1. **Fuzzy personal vocabulary**: "that stressful email from last month" — no keywords to decompose
2. **Cross-language content**: emails in multiple languages where FTS tokenization breaks down
3. **Similarity queries**: "find emails like this one" — explicitly relational

These are worth retaining as opt-in `--semantic` behavior, not as the default that every query pays for.

---

## What Gets Removed

If semantic search is fully retired (not just opt-in):

| Component | Status | Notes |
|-----------|--------|-------|
| LanceDB vector store | **Remove** | `~/.zmail/data/vectors/` directory gone |
| `lancedb` npm dependency | **Remove** | ~50MB, native bindings, platform-specific |
| OpenAI embedding API calls | **Remove** | No longer needed at sync or query time |
| `OPENAI_API_KEY` requirement | **Remove** | No longer a setup blocker |
| `embedding_state` column | **Remove** | No more pending/failed embedding tracking |
| `embeddings.ts` / `vectors.ts` | **Remove** | ~200 lines of embedding + vector search code |
| Hybrid RRF merge logic | **Remove** | The source of double-truncation bugs (BUG-016) |
| Background embedding backfill | **Remove** | No more indexing lag after sync |
| LanceDB in `src/search/index.ts` | **Remove** | `vectorSearchFromEmbedding`, `addEmbeddingsBatch` |

What remains: SQLite FTS5 — zero external dependencies, single file, deterministic, already battle-tested. The entire search stack becomes `ftsSearch()` + structured SQL filters.

## Implications for Other Items

| Item | Impact |
|------|--------|
| **BUG-016** (exhaustive enumeration) | FTS-first makes the fix simpler and more natural: domain routing → `from:` filter → SQL exhaustive scan. No semantic interference, no hybrid merge bugs. |
| **BUG-017** (semantic recall gap) | **Resolved** as a consequence of this change. The failure was semantic search; FTS + agent query decomposition is the fix. |
| **OPP-002** (local embeddings) | **Superseded** if semantic is fully retired. If retained as opt-in, OPP-002 addresses the opt-in latency. |
| **OPP-018** (reduce round-trips) | Still valid and orthogonal — body preview and batch get_message help regardless of search mode. |
| **OPP-006** (attachment search) | FTS indexing of extracted attachment text is the right path — same argument applies, FTS on extracted text beats embeddings for agent-driven search. |
| **Setup / onboarding** | `OPENAI_API_KEY` no longer required → one fewer setup step, no API key friction for new users. |

---

## Open Questions

- **When does agent query decomposition fail?** Are there real queries where an agent genuinely can't generate useful FTS terms and must rely on embedding similarity? If so, how common are they in practice?
- **Attachment content search** (OPP-006): FTS indexing of attachment text is a natural complement to FTS-first. Semantic embeddings of attachment content have the same problems as email semantic search — probably want FTS on extracted text instead.
- **Cold start for semantic opt-in**: If semantic is rare/opt-in, should we defer LanceDB initialization until it's requested? This would eliminate cold-start overhead for the 99% case.
- **Migration**: Existing users have `hybrid` as their mental model and may depend on semantic for certain queries. Clear communication needed when changing the default.

---

## References

- Bakeoff #2 (semantic failure): `../ztest/feedback/submitted/bakeoff-002-entrepreneur-meeting.md`
- Bakeoff #5 (FTS confirmation): `../ztest/feedback/submitted/bakeoff-005-entrepreneur-rematch.md`
- Related architecture: [ARCHITECTURE.md](../ARCHITECTURE.md) — ADR-006 (embedding/search strategy) should be updated to reflect this decision
- Superseded by this: [OPP-002](OPP-002-local-embeddings.md) (local embeddings) — reduced priority
- Resolved by this: [BUG-017](../bugs/BUG-017-semantic-recall-gap-intent-queries.md) (semantic recall gap)
- Simplified by this: [BUG-016](../bugs/BUG-016-bakeoff-incomplete-coverage-critical.md) (exhaustive enumeration — domain routing becomes the clean fix)
