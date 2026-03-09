# zmail Performance Metrics

This document summarizes **observed performance** on the platform as of 2025–2026: query latencies, example commands, and response payloads. Data was collected from a live index (~2K messages, Node 20+, macOS) using `zmail search --timings` and `zmail who` (JSON includes `_timing.ms`).

**Summary:** Keyword (FTS) and hybrid search consistently complete in **&lt;50ms** in-process. Semantic (hybrid) search adds an embedding API call when the query is not cached; that round-trip dominates total time (~200–400ms). `zmail who` is in-process only and typically **5–35ms**.

---

## 1. Search performance

### 1.1 Timing breakdown

Search supports two modes:

| Mode | Flag | Description |
|------|------|-------------|
| **FTS-only** | `--fts` | SQLite FTS5 keyword match only. No embedding call. |
| **Hybrid** (default) | *(none)* | FTS5 + semantic (LanceDB). Reciprocal-rank fusion. May call OpenAI for query embedding. |

When you pass `--timings`, the CLI returns a `timings` object in the JSON:

- **`totalMs`** — End-to-end search time (in-process).
- **`ftsMs`** — Time for FTS5 query.
- **`embedMs`** — Time to get query embedding (OpenAI API); 0 for FTS-only.
- **`vectorMs`** — Time for LanceDB vector search; 0 for FTS-only.
- **`mergeMs`** — Time to merge and rank FTS + semantic results.

### 1.2 Observed timings (representative)

| Query type | Example | totalMs | ftsMs | embedMs | vectorMs | mergeMs |
|------------|---------|---------|-------|---------|----------|---------|
| FTS-only keyword | `invoice` | **2** | 2 | — | — | — |
| Hybrid keyword | `invoice` | **15** | 1 | 2 | 12 | 0 |
| Hybrid with filters | `from:stripe receipt` | **12** | 0 | 2 | 9 | 1 |
| Filter-only (no text) | `after:7d` | **2** | — | — | — | — |
| Semantic-heavy (cold embed) | `meeting notes summary` | **403** | 1 | 388 | 14 | 0 |

**Takeaways:**

- **Keyword and filter-only:** Consistently **&lt;50ms** (often 1–2ms FTS, &lt;20ms total for hybrid when embedding is fast or cached).
- **Semantic cold:** Total time dominated by `embedMs` (OpenAI round-trip). In-process FTS + vector + merge stay in the **&lt;20ms** range.
- Wall-clock for the full CLI process (including Node startup) is ~600–1000ms; the numbers above are **in-process search only**.

---

## 2. Example search queries and payloads

### 2.1 CLI

**FTS-only (keyword), with timings**

```bash
zmail search "invoice" --fts --timings
```

**Representative response (trimmed):**

```json
{
  "results": [
    {
      "messageId": "<0101019cb4f2c8f8-...@us-west-2.amazonses.com>",
      "threadId": "<0101019cb4f2c8f8-...@us-west-2.amazonses.com>",
      "date": "2026-03-03T18:25:35.000Z",
      "fromAddress": "invoice+statements+acct_1EKx2XDIYnolrrZs@stripe.com",
      "fromName": "Clerk, Inc.",
      "subject": "Your receipt from Clerk, Inc. #2952-5978",
      "rank": -7.458849291083696
    }
  ],
  "truncated": false,
  "totalMatched": 20,
  "returned": 20,
  "hint": "Tip: Narrow results with from:name or subject:keyword",
  "timings": {
    "totalMs": 2,
    "ftsMs": 2
  }
}
```

**Hybrid (semantic + FTS), with timings**

```bash
zmail search "invoice" --timings
```

**Representative timings block:**

```json
"timings": {
  "totalMs": 15,
  "ftsMs": 1,
  "embedMs": 2,
  "vectorMs": 12,
  "mergeMs": 0
}
```

**With inline operators**

```bash
zmail search "from:stripe receipt" --timings
zmail search "after:7d subject:meeting" --timings
zmail search "from:alice@example.com invoice OR receipt" --limit 10
```

**Filter-only (no query text)** — date/metadata only:

```bash
zmail search "after:7d" --timings --limit 3
```

**Representative timings:** `"totalMs": 2` (no FTS/semantic breakdown when there is no query text).

### 2.2 MCP (`search_mail`)

Same index and search implementation; parameters map to CLI:

| MCP parameter | Example |
|---------------|---------|
| `query` | `"invoice from:stripe after:30d"` |
| `limit` | `10` |
| `offset` | `0` |
| `fts` | `true` for FTS-only |
| `afterDate` | `"30d"` or `"2025-01-01"` |
| `beforeDate` | `"7d"` or `"2025-12-31"` |
| `fromAddress` | `"alice@example.com"` |

MCP does not currently return a `timings` object; latency characteristics are the same as CLI (in-process).

---

## 3. `zmail who` performance and examples

`zmail who` looks up people by email address or display name and returns sent/received/mentioned counts (and optional enriched fields). It does **not** call an embedding API unless you pass `--enrich`. All timings below are without `--enrich`.

### 3.1 Observed timings

| Query | Result count | _timing.ms |
|-------|----------------|------------|
| `who "cirne"` | 4 people | **35** |
| `who "zoom"` | 2 people | **16** |
| `who "github"` | 0 people | **5** |

So: **~5–35ms** for in-process who lookups; empty results are faster.

### 3.2 Example: name or family-name query

**Command:**

```bash
zmail who "cirne"
```

**Representative payload (trimmed):**

```json
{
  "query": "cirne",
  "people": [
    {
      "primaryAddress": "lewiscirne@mac.com",
      "addresses": [
        "lewiscirne@alum.dartmouth.org",
        "lewiscirne@gmail.com",
        "lewiscirne@icloud.com",
        "lewiscirne@mac.com",
        "lewiscirne@me.com"
      ],
      "sentCount": 46,
      "receivedCount": 1888,
      "mentionedCount": 1888,
      "phone": null,
      "title": null,
      "company": null,
      "lastContact": "2026-03-07T19:36:42.000Z",
      "firstname": "Lewis",
      "lastname": "Cirne"
    },
    {
      "primaryAddress": "katelyncirne@gmail.com",
      "addresses": ["katelyncirne@gmail.com", "katelyn_cirne@icloud.com"],
      "sentCount": 0,
      "receivedCount": 3,
      "mentionedCount": 3,
      "lastContact": "2026-02-23T20:37:42.000Z",
      "firstname": "Katelyn",
      "lastname": "Cirne"
    }
  ],
  "hint": "Tip: Use --enrich flag for more accurate name inference and better deduplication (adds ~1-2s latency)",
  "_timing": { "ms": 35 }
}
```

### 3.3 Example: domain or company-like term

**Command:**

```bash
zmail who "zoom"
```

**Representative payload (trimmed):**

```json
{
  "query": "zoom",
  "people": [
    {
      "primaryAddress": "billing@zoom.us",
      "addresses": ["billing@zoom.us"],
      "sentCount": 1,
      "receivedCount": 0,
      "mentionedCount": 0,
      "lastContact": "2026-03-06T04:56:34.000Z",
      "name": "Zoom"
    },
    {
      "primaryAddress": "teamzoom@e.zoom.us",
      "addresses": ["teamzoom@e.zoom.us"],
      "sentCount": 1,
      "receivedCount": 0,
      "mentionedCount": 0,
      "phone": "+18887999666",
      "title": "Zoom Video Communications",
      "company": "Inc",
      "lastContact": "2026-02-27T17:36:52.000Z",
      "name": "Zoom",
      "urls": ["https://click.e.zoom.us/..."]
    }
  ],
  "_timing": { "ms": 16 }
}
```

### 3.4 MCP `who` tool

Same data and semantics; parameters:

- `query` (required): e.g. `"alice"`, `"stripe.com"`, `"Zoom"`
- `limit`, `minSent`, `minReceived`, `includeNoreply`, `enrich` (optional)

`enrich: true` uses an LLM pass and adds ~1–2s; it is not used in the metrics above.

---

## 4. Summary for strategic/marketing use

- **Keyword / filter-only search:** **&lt;50ms** in-process (often 1–5ms for FTS).
- **Hybrid search (keyword + semantic):** **&lt;50ms** when embedding is fast or cached; **~200–400ms** when the semantic path does a cold OpenAI embedding call.
- **`zmail who`:** **~5–35ms** in-process; no external API unless `--enrich` is used.

These numbers support the claim that a **local index** gives agents orders-of-magnitude lower latency than per-query API proxies to provider APIs (e.g. 200–500ms per Gmail API call), and no rate limits for iterative or bulk queries.

---

*Metrics collected 2026-03-07; index ~1,929 messages. Re-run with `zmail search "<query>" --timings` and `zmail who "<query>"` (JSON includes `_timing`) to refresh.*
