# Exa.ai Integration — Where It Adds Value

> This document explores how Exa.ai (or a similar neural web search API) could enhance zmail's search and indexing, specifically focusing on what Exa *inside* zmail does that an agent calling Exa *separately* cannot.

**Stale diagram (below):** zmail is **FTS-only** today (no LanceDB/embeddings worker). Use **`zmail refresh`** wherever this doc says **`zmail sync`**.

## Core Insight

zmail has **corpus-level context** the agent doesn't have at query time. The agent knows what it's asking; zmail knows what's in 500K emails. Exa has **web-scale context** zmail doesn't have. The integration point is where those two contexts meet.

Two patterns emerge:

1. **Sync-time enrichment** — amortize expensive web lookups during sync so they're instant at query time.
2. **Query-time fusion** — use corpus context to generate better Exa queries than the agent could from the raw prompt alone.

---

## 1. Link Expansion at Sync Time

**The biggest win.**

Emails are full of URLs — articles, Google Docs, proposals, dashboards, shared links — but the email body often just says "check this out" or "see the doc here." The *content* the sender pointed to is invisible to FTS5 and embeddings alike.

If zmail ran Exa's content extraction during sync:

```
Sync worker (existing):  IMAP → .eml → SQLite + FTS5
Link worker (new):       Extract URLs from body_text → Exa /contents → store → FTS5
```

- Extract and dedupe URLs from `body_text` during sync
- Call Exa's `/contents` endpoint to get clean markdown for each URL
- Store extracted content in a `link_contents` table, associated with the message
- Index in FTS5 alongside body text

**Why the agent can't do this themselves:** The agent doesn't know which URLs exist across the email corpus until *after* it searches. Even then, it would need to extract URLs from results, call Exa for each, and correlate — multiple round-trips per query. zmail doing it at sync time means link content is pre-indexed and searchable in the same sub-100ms FTS5 query as everything else.

A search for "indemnification clause" now matches the *contract linked in the email*, not just the email text.

This is the web equivalent of attachment extraction (ADR-012). Same principle: make the content *behind* the email searchable, not just the email itself.

---

## 2. Fused Search: Email + Web in One Query

The typical agent workflow today:

```
1. Agent calls zmail: "competitor pricing changes"
2. Agent reads results, identifies the competitor name
3. Agent calls Exa: "Acme Corp pricing 2026"
4. Agent synthesizes both
```

With Exa in zmail, this collapses to one call:

```
zmail search "competitor pricing changes" --enriched

  → Hybrid search (semantic + FTS5) over local email
  → Extract entities/topics from top results (company names, product names)
  → Parallel Exa search for those entities + the original query
  → RRF merge: email results + web results, ranked together
  → Return unified result set with provenance tags (email vs. web)
```

**What makes this different from the agent doing it:** zmail extracts the *right* Exa queries from corpus context. The agent only has the user's prompt. zmail has seen that "competitor" means "Acme Corp" because that's who appears in those email threads. It generates targeted Exa queries the agent wouldn't know to make without first reading the email results.

---

## 3. Contact/Entity Enrichment at Sync Time

Every email has a sender domain (and often a display name). During sync, zmail could enrich identities so `zmail who` and contact lookups return web-derived context without an extra agent round-trip. This aligns with the people/contacts work in [OPP-004: People Index and Writable Contacts](opportunities/archive/OPP-004-people-index-contacts.md) — the extended contacts (or people/people_emails) schema is the natural place to store Exa-derived fields.

**Low-hanging fruit (domain-only):**

```
Enrich worker:
  → New sender domain → Exa search "what is {domain}"
  → Store company summary, industry, description (e.g. in contacts or people table)
  → Available instantly when agent asks "who is this person"
```

No people index required: key by domain, attach to any message/sender lookup. One Exa call per new domain, amortized at sync time.

**Next step (person-level enrichment):** Once we have a people index (OPP-004 Milestone 2), the enrich worker can do one Exa lookup per *identity* (e.g. first time we see a new address or above a sent_count threshold):

```
  → New or high-signal identity (e.g. sent_count ≥ 5) → Exa search "{display_name} {domain}" or "who is {email}"
  → Store role, company, industry, one-line bio on the people/contact record
  → zmail who / zmail contact show return "Jane Smith, VP Legal at Acme (Series C enterprise SaaS)" in one response
```

**Cost control:** Only enrich identities above a threshold (e.g. min sent_count) or on first `zmail contact show` (lazy) to limit Exa API usage.

**Why at sync time:** The agent asking "tell me about the person who emailed me about the contract" currently has to: search zmail → get the sender → call Exa for the company → answer. With pre-enriched contacts, zmail returns "Jane Smith, VP Legal at Acme Corp (Series C enterprise SaaS company)" in the same response. Zero additional latency.

---

## 4. Similarity from Private Threads

Exa's similarity search takes a URL or text and finds related web content. zmail has something Exa alone doesn't: private email threads.

```
zmail similar <thread_id>

  → Read thread content
  → Exa findSimilar(thread_content)
  → Return web pages related to this private conversation
```

Use case: an agent working on a deal reads a thread, then asks "what else is out there about this?" zmail can answer because it has the thread content *and* Exa access. The agent calling Exa separately would need to extract, summarize, and query. zmail does it in one operation with full context.

---

## 5. When Exa Inside zmail is NOT Better

- **Pure web search** — agent just wants to search the web. zmail adds no value wrapping a pass-through.
- **One-off lookups** — "What's Acme's stock price?" No email context to leverage.
- **Agent already has full context** — agent just read 10 emails and knows exactly what to search Exa for. The extra hop through zmail adds latency.

The rule: if the query doesn't benefit from corpus context or pre-indexed enrichment, the agent should call Exa directly.

---

## Architecture

Fits the existing two-worker model (ADR-020) by adding a third concurrent worker:

```
zmail refresh   # (historical docs may say "sync")
├── Sync worker:    IMAP → maildir + SQLite           (bandwidth-bound)
├── Index worker:   (historical) embeddings pipeline — not in current product
└── Enrich worker:  URLs/contacts → Exa → SQLite      (API-rate-bound, hypothetical)
```

The enrich worker follows the same pattern: concurrent but independent, runs during sync, advisory-locked, progressive availability. Messages are searchable via FTS5 immediately; enriched link content and contact data become available as the enrich worker catches up.

### New search mode

| Mode | What it does |
|---|---|
| Default (hybrid) | Semantic + FTS5 search (existing RRF merge) |
| `--fts` | FTS5-only search (exact keyword matching) |
| `--enriched` | Hybrid + Exa web search fused via RRF, entity-aware query expansion (future) |

### New storage

| Table | Contents | Indexed in FTS5? |
|---|---|---|
| `link_contents` | Extracted markdown from URLs found in emails | Yes |
| `contacts` (extended) | Company summary, industry, description from domain lookup | No (metadata) |

---

## Summary

| Scenario | Why zmail + Exa wins |
|---|---|
| **Link expansion** | Pre-indexed at sync time. O(1) at query time vs. O(n) URL fetches per query. |
| **Fused search** | Corpus-aware entity extraction generates better Exa queries than the agent's raw prompt. |
| **Contact enrichment** | Amortized at sync time. Instant at query time. |
| **Thread similarity** | zmail has private content; Exa has the web. Neither alone can bridge both. |

The pattern is always the same: **zmail has corpus context the agent doesn't, and Exa has web context zmail doesn't. The value is where those two contexts meet.** Sync-time enrichment amortizes cost; query-time fusion leverages corpus-aware expansion.

---

## See also

- [OPP-004: People Index and Writable Contacts](opportunities/archive/OPP-004-people-index-contacts.md) — `zmail who`, people index at index time, and `zmail contact` for writable metadata. Exa contact/entity enrichment (above) is the web-enrichment layer for that same people/contacts model.
