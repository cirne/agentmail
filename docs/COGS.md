# Cost of Goods Sold — Unit Economics

> This document models the per-user cost structure for zmail across deployment modes: self-hosted (open source), and a hypothetical hosted service.

---

## The Punchline

Semantic embedding — the most differentiated capability — is the cheapest cost line. The entire email corpus of a heavy user can be embedded for under $5 one-time, with ongoing costs of pennies per month. This inverts the usual AI-product economics where model inference dominates COGS.

---

## Embedding Costs (OpenAI `text-embedding-3-small`)

**Pricing:** $0.02 per 1M tokens. Batch API: $0.01 per 1M tokens (50% discount for non-time-sensitive workloads).

**Tokens per email:** The indexer truncates at 8,000 characters. Typical emails average 200–500 words. Conservative estimate: ~500 tokens per email on average.

### Initial Backfill (one-time)

| User profile | Emails | Tokens | Cost | Batch API |
|---|---|---|---|---|
| Light (1 year) | 5,000 | 2.5M | $0.05 | $0.025 |
| Medium (5 years) | 100,000 | 50M | $1.00 | $0.50 |
| Heavy (10 years) | 500,000 | 250M | $5.00 | $2.50 |

**Worst case:** If every email maxes the 8K char truncation limit (~5,700 tokens), a 500K-email heavy user costs $57 to backfill. In practice this never happens — the average is far below the truncation limit.

### Incremental (ongoing, monthly)

| Daily volume | Tokens/day | Monthly cost |
|---|---|---|
| 20 emails/day | 10K | $0.006 |
| 50 emails/day | 25K | $0.015 |
| 200 emails/day | 100K | $0.06 |

Incremental embedding cost is effectively zero.

### Semantic Search Queries

Each search query also requires embedding the query string. Query strings are short (10–50 tokens). At $0.02/M tokens, 1,000 searches costs $0.001. Not worth tracking.

---

## Compute Costs

### Self-Hosted (Phase 2 — open source)

Zero. The user runs zmail on their own machine or server. Bun + SQLite + LanceDB are all in-process — no external services required. If the user provides their own OpenAI API key, embedding cost is on them. If they run a local model (Ollama), embedding cost is also zero.

### Hosted Service (Phase 3 — hypothetical)

Single-user-per-container architecture. Each user gets an isolated process with their own SQLite DB and LanceDB vectors on a persistent volume.

| Provider | Spec | Monthly cost |
|---|---|---|
| DigitalOcean App Platform (basic) | 1 vCPU, 512MB RAM | $5 |
| DigitalOcean App Platform (standard) | 1 vCPU, 1GB RAM | $10 |
| Fly.io (shared) | shared-cpu-1x, 256MB | $3 |
| Fly.io (dedicated) | 1 vCPU, 1GB RAM | $7 |

SQLite + LanceDB are lightweight. A single vCPU with 512MB–1GB RAM handles a single-user workload comfortably — FTS5 queries are sub-10ms, vector search is sub-100ms.

---

## Storage Costs

### Volume Sizing Per User

| Component | Light user | Heavy user | Notes |
|---|---|---|---|
| Raw `.eml` files (Maildir) | 1–3 GB | 10–20 GB | Depends on attachment volume |
| SQLite DB (metadata + FTS5) | 100–500 MB | 1–3 GB | `body_text` stored for FTS |
| LanceDB vectors | 30 MB | 300 MB | 1536 dims × 4 bytes × N messages |
| **Total** | **~2–4 GB** | **~12–24 GB** |

### Hosted Storage Pricing

| Provider | $/GB/month | Light user/mo | Heavy user/mo |
|---|---|---|---|
| DigitalOcean Volumes | $0.10 | $0.20–0.40 | $1.20–2.40 |
| Fly.io Volumes | $0.15 | $0.30–0.60 | $1.80–3.60 |
| S3 / DO Spaces (cold) | $0.02 | $0.04–0.08 | $0.24–0.48 |

Storage is the second-largest cost line after compute, but still modest — a few dollars per month for even the heaviest users.

---

## Bandwidth Costs (Sync)

IMAP sync downloads raw email. Most hosting providers include generous bandwidth:

- DigitalOcean: 1 TB/month included
- Fly.io: outbound charged at $0.02/GB after 100 GB free

IMAP is inbound traffic (provider → zmail container), which is typically free. After initial backfill, incremental sync transfers are small (a few MB/day for most users).

Not a meaningful cost line.

---

## Total COGS by Deployment Mode

### Self-Hosted (open source user)

| Component | Cost to zmail |
|---|---|
| Compute | $0 (user's machine) |
| Storage | $0 (user's disk) |
| Embeddings (OpenAI key) | $0 (user's API key) |
| Embeddings (local model) | $0 |
| **Total** | **$0** |

The open-source product has zero COGS. Revenue opportunities are support, hosted offering, or enterprise features.

### Hosted Service — Per-User Monthly COGS

| Component | Light user | Medium user | Heavy user |
|---|---|---|---|
| Compute (container) | $5 | $5 | $10 |
| Storage (volume) | $0.30 | $0.80 | $2.50 |
| Embedding (incremental) | $0.01 | $0.02 | $0.06 |
| Embedding (backfill, amortized 12 mo) | $0.004 | $0.08 | $0.42 |
| Bandwidth | ~$0 | ~$0 | ~$0 |
| **Total COGS/user/month** | **~$5.30** | **~$5.90** | **~$13.00** |

---

## Margin Analysis

| Consumer price point | Light user margin | Medium user margin | Heavy user margin |
|---|---|---|---|
| $10/month | 47% | 41% | — |
| $15/month | 65% | 61% | 13% |
| $20/month | 74% | 71% | 35% |

**Observations:**

- Compute is the dominant cost, not AI/embeddings. This is unusual — most AI products have model inference as their biggest COGS line. Embedding costs are <1% of total COGS.
- Heavy users are expensive because of storage (10–20 GB of raw email), not because of AI. Tiered storage pricing or attachment-size limits could manage this.
- At $15/month, medium users (the likely core segment) yield ~61% gross margin. This is healthy SaaS economics.
- Multi-tenancy would dramatically reduce compute costs. Sharing a Bun process across users (with SQLite-per-user isolation) could cut the $5 compute floor to $1–2/user. This shifts all tiers to 70%+ margins.

---

## Scale Economics

### Why This Gets Cheaper, Not More Expensive

1. **Embedding models get cheaper.** OpenAI's embedding pricing has dropped 5x in two years ($0.10 → $0.02/M tokens). The trend continues. Future models may be 10x cheaper.

2. **Local embedding eliminates the cost entirely.** Small, fast embedding models (Nomic, mxbai, gte) run locally and are free. As these improve, the hosted service can run embeddings in-process instead of calling an API.

3. **Compute density improves.** Multi-tenant architecture, where one process serves multiple users with isolated SQLite databases, reduces the per-user compute floor. SQLite is designed for exactly this kind of embedded multi-database workload.

4. **Storage is one-time per email.** Email is immutable after receipt. There's no ongoing storage growth per message — only new messages add storage cost, and the rate is predictable.

### The Structural Cost Advantage

For comparison, an API-proxy approach (forwarding queries to Gmail's API) has different economics:

| | API proxy | Local index (zmail) |
|---|---|---|
| Storage | $0 (stored by provider) | $0.30–$2.50/user/mo |
| Compute per query | Provider API call (~200ms) | Local SQLite (~1ms) |
| Embedding cost | N/A (no semantic search) | $0.01–$0.06/user/mo |
| Rate limit risk | Yes (provider-imposed) | No |

An API proxy has lower COGS but dramatically fewer capabilities. The cost delta between the two approaches is a few dollars per month — the price of storage and embeddings — but the capability delta is enormous (semantic search, attachment intelligence, offline, multi-provider).

---

## Key Takeaway

The most expensive thing about zmail is a $5/month container, not AI. Embeddings — the core differentiator — cost pennies. This means semantic search can be a default capability, not a premium upsell. Every user gets the full intelligence layer because it costs almost nothing to provide.
