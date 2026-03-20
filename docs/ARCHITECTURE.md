# Architecture & Design Decisions

This document tracks concrete architectural decisions made during design and development.
See [VISION.md](./VISION.md) for the product vision and goals.

**Why one file:** ADRs cross-reference each other heavily (e.g. ADR-016 → ADR-017 → ADR-020) and an agent making an architectural decision benefits from scanning the full decision log for context and shape, not just one answer. Keeping everything here also means grep and semantic search find everything without following links. If this file grows unwieldy (say, past ADR-030), split into individual files under `docs/adr/` with an index table here — same pattern as [OPPORTUNITIES.md](./OPPORTUNITIES.md).

---

## Decision Log

### ADR-001: Phase 1 Scope — IMAP Sync → SQLite → MCP Server

**Decision:** The minimum useful Phase 1 system is:

```
IMAP provider → raw email store → SQLite FTS5 index → MCP server
```

**Rationale:** If you can search your own email from an agent (Cursor, Claude Desktop) in natural language, the core value is proven. Everything else — filesystem interface, semantic embeddings, replacement SMTP mode — comes later.

**Deferred:** Filesystem (FUSE) interface, SMTP ingress (MX hosting), semantic/vector search, multi-user. **Send (SMTP outbound)** is in the vision ([VISION.md](./VISION.md) — "The Full Loop"). Send is blocked on customer validation for core search/index/onboarding — we want to nail that first.

---

### ADR-002: Storage — Embedded + Persistent Volume Throughout

```
Container
└── /data  (persistent volume — survives redeploys)
    ├── maildir/           ← raw .eml files
    ├── zmail.db           ← SQLite: metadata, FTS5 index, sync state
    ├── vectors/           ← (deferred) LanceDB embedded
    └── embedding-cache/   ← (deferred) OpenAI embedding responses by (model, input hash)
```

This layout applies to **both Phase 1 and Phase 2 (open source)**. Each user runs their own container with their own volume. There is no shared infrastructure to scale.

**Phase breakdown:**

| Phase | Description | Storage |
|---|---|---|
| Phase 1 | Personal deployment | Container + DO persistent volume |
| Phase 2 | Open source release | Docker Compose, each user brings their own volume |
| Phase 3 | Hosted SaaS (if ever) | Stateless container + S3 + Postgres |

**Rationale:** Phase 2 is open source self-hosting — not a multi-tenant service. S3 and Postgres are only needed if/when a hosted SaaS is built (Phase 3). Keeping everything embedded avoids S3 SDK complexity, network latency on every read, and bucket credential management. A volume snapshot is a complete backup.

**Volume sizing:** 10 years of heavy Gmail (500K emails) with embeddings lands at ~20GB. A $2/mo DO volume is sufficient with headroom.

**Result:** The raw email store (Maildir) is the durable artifact. The SQLite index and LanceDB vectors are always rebuildable from it without touching IMAP.

---

### ADR-003: IMAP Sync Resumption via UID Checkpointing

**See also:** [SYNC.md](./SYNC.md) — Current sync implementation and optimization history.

**Decision:** Sync state is tracked per folder as `{ folder, uidvalidity, last_uid }`. Two distinct sync modes optimize for different use cases:

1. **Forward sync (`zmail refresh`):** Uses UID range search (`UID ${last_uid + 1}:*`) to fetch only new messages since last sync. Efficient for frequent updates.
2. **Backward sync (`zmail sync`):** Resumes from oldest synced date, uses UID filtering to skip already-synced messages. Efficient for initial setup and backfill.

**Rationale:** IMAP UIDs are stable, monotonically increasing identifiers. Checkpointing the last-seen UID per folder allows sync to resume exactly where it left off after a redeploy, crash, or restart — without re-downloading previously synced messages. `UIDVALIDITY` detects the rare case where a folder was wiped and recreated, triggering a full re-sync of that folder.

**Efficiency optimizations:**
- **Forward sync:** UID range search (`UID N:*`) only queries IMAP for messages we haven't synced yet. Server-side filtering avoids fetching headers for messages we already have.
- **Backward sync:** When resuming from oldest synced date, if all UIDs from a search are <= `last_uid`, we skip fetching entirely and search before that date instead. This avoids re-fetching 100+ messages we already have when extending a date range.
- **Same-day safety:** Backward sync allows re-fetching from the same day as oldest synced to catch gaps from interrupted syncs, but uses UID filtering to skip messages we've already synced.

**Result:** The raw email store (Maildir or R2) is the durable artifact. The index is always rebuildable from the raw store without touching IMAP. Both sync modes are optimized to avoid unnecessary fetches while maintaining correctness.

---

### ADR-004: Local Dev — Sync Last N Days by Default

**Decision:** Local development syncs only the last 7 days of email by default. Production deployments do a full historical backfill.

**Rationale:** IMAP sync is bandwidth-heavy. Developers shouldn't wait for a full archive sync on every fresh checkout. A `--full` flag (or env var) enables full sync explicitly.

---

### ADR-005: Dual Agent Interface — Native CLI + MCP Server

**Decision:** The system exposes two agent interfaces that share the same underlying index:

1. **Native CLI binary** — primary interface for local agent use (Claude Code, OpenClaw, terminal)
2. **MCP server** (`zmail mcp`) — for remote/hosted deployments

**CLI commands:**
```
zmail sync [--since <spec>]     ← Initial sync: fill gaps going backward (e.g. --since 7d, 5w, 3m, 2y)
zmail refresh                    ← Refresh: fetch new messages since last sync (frequent updates)
zmail search <query> [flags]    ← FTS5 full-text search
                                  Query supports inline operators: from:, to:, subject:, after:, before:
                                  Example: zmail search "from:alice@example.com invoice OR receipt"
zmail who <query> [flags]        ← find people by address or display name (sent/received/mentioned counts)
zmail status [--imap]           ← sync/indexing/search readiness (--imap for IMAP server comparison)
zmail stats                     ← DB stats (volume + top senders/folders)
zmail read <id> [--raw]         ← read a message (or: zmail message <id>)
zmail thread <id> [--json]      ← fetch full thread (text by default; --json for structured output)
zmail mcp                       ← start MCP server (stdio)
```

**Sync modes:**
- **`zmail sync`** (backward): Initial setup and backfill. Resumes from oldest synced date, fills gaps going backward. Uses date-based search with UID filtering to skip already-synced messages.
- **`zmail refresh`** (forward): Frequent updates. Uses UID range search (`UID ${last_uid + 1}:*`) to fetch only new messages. Much faster than date-based search for incremental updates.

**Rationale:** Agents like Claude Code and OpenClaw can invoke shell commands directly. A subprocess call to `zmail search` is faster than an MCP HTTP round-trip, requires no running server, and has no port management. The CLI defaults to JSON for structured commands (`search`, `who`, `attachment list`) so agents can consume output directly. See [ADR-022](#adr-022-cli-output-format--json-default-for-structured-commands-text-for-progressivecontent-commands) for output format decisions.

MCP remains the right interface for remote/hosted deployments where the index lives on a server the agent can't shell into.

Both modes hit the same SQLite index. The binary is the same artifact.

**See also:** [OPP-004: People Index and Writable Contacts](opportunities/archive/OPP-004-people-index-contacts.md) — roadmap for people index at index time, `zmail contact`, and MCP who/contact tools.

---

### ADR-006: Storage Layers

**Decision:** Four distinct storage layers, each optimized for its access pattern:

| Layer | Phase 1 + 2 | Phase 3 (hosted SaaS, if ever) |
|---|---|---|
| Raw email files | Maildir on persistent volume | S3 / DO Spaces |
| Structured metadata + FTS | File-backed SQLite via `better-sqlite3` (async app-level facade; ADR-023) | Postgres |
| Semantic / vector search | (deferred) LanceDB on volume | LanceDB → S3 |

**SQLite schema (Phase 1):**
```
mailboxes     (folder, uidvalidity, last_uid)
messages      (message_id, thread_id, from, to, subject, date, body_text, ...)
threads       (thread_id, subject, participant_count, last_message_at)
contacts      (address, display_name, message_count)
attachments   (message_id, filename, mime_type, size, stored_path)
sync_state    (folder, uidvalidity, last_uid)
```
FTS5 virtual tables on `body_text` and `subject` live in the same `.db` file.

**Full-text search:** SQLite FTS5. Handles millions of emails with sub-100ms queries. No external service, runs in-process, trivially backed up as a single file.

**Vector / semantic search (deferred):** Current implementation is FTS-only ([OPP-019](opportunities/OPP-019-fts-first-retire-semantic-default.md)). LanceDB and embedding generation may be reintroduced later; design assumed LanceDB embedded on volume, S3 backend for Phase 3.

---

### ADR-007: Security Baseline

**Decisions:**
- **IMAP auth:** App passwords (not OAuth) for Phase 1 — simpler, revocable, no token refresh complexity.
- **Secrets:** All credentials (IMAP password, MCP auth token) passed via environment variables. Never committed to the repo.
- **MCP auth:** Static bearer token set at deploy time. Required — the MCP endpoint must not be publicly accessible without auth.
- **Storage encryption:** Fly.io volumes are encrypted at rest by default. Raw email is never transmitted without TLS.

---

### ADR-008: Language & Runtime — TypeScript + Node.js

**Decision:** TypeScript on Node.js 20+. Dev: `tsx` runs source directly; distribution: `tsc` + `tsc-alias` → `dist/`, install via `npm install -g @cirne/zmail` (see [OPP-007](opportunities/archive/OPP-007-packaging-npm-homebrew.md)).

**Rationale:**
- Node.js is ubiquitous; no separate runtime (Bun) required. Aligns with OpenClaw/Claude Code (`npm i -g`).
- **better-sqlite3** for SQLite — synchronous native binding, **true file-backed** SQLite (suitable for very large `.db` files; RSS bounded by OS cache, not file size). Packaged with **`postinstall` → `npm rebuild better-sqlite3`** so the addon matches the installing Node’s `NODE_MODULE_VERSION` (ADR-023).
- `tsx` gives first-class TypeScript in development without a build step.
- Strong ecosystem for IMAP (`imapflow`) and MCP SDK.

---

### ADR-009: Hosting — DigitalOcean

**Decision:** DigitalOcean App Platform for container hosting.

**Phase 1 + 2:** App Platform container + DO persistent volume
**Phase 3 (if ever):** App Platform container + DO Spaces + DO Managed Postgres

**Rationale:**
- Already in use for other projects — no new account, billing, or mental model.
- App Platform handles Docker + GitHub auto-deploy + persistent volumes without managing a raw VM.
- DO Spaces (S3-compatible) and DO Managed Postgres are available in-platform if Phase 3 is ever needed.
- AWS adds IAM/ECS/ALB complexity that isn't justified at this stage.

### ADR-010: Storage Abstraction

**Decision:** File storage access is behind a `StorageAdapter` interface, but defaults to `LocalAdapter` for both Phase 1 and Phase 2.

**Implementations:**
- `LocalAdapter` — reads/writes to local filesystem path (default for all phases)
- `S3Adapter` — reads/writes to any S3-compatible bucket (Phase 3 / power-user option)

**Rationale:** The abstraction keeps the option open without requiring it. A user who wants to back up their Maildir to S3 can configure an `S3Adapter`. The default experience requires no cloud credentials.

---

### ADR-011: Email Provider — IMAP-first, Gmail as Priority Target

**Decision:** Use IMAP as the sync protocol (not the Gmail REST API). Gmail is the priority provider with a dedicated implementation to handle its quirks.

**Why IMAP over the Gmail API:**
- IMAP generalizes to Fastmail, iCloud, Outlook — one sync engine covers all providers.
- Gmail API requires OAuth regardless, locks Phase 1 to Gmail only, and adds REST client complexity before the core system exists.
- Gmail's proprietary IMAP extensions (`X-GM-THRID`, `X-GM-LABELS`) provide native thread IDs and labels — no need for the REST API.

**Gmail-specific behavior:**
- Always sync from `[Gmail]/All Mail`, never individual label folders. Labels appear as IMAP pseudo-folders; syncing them individually downloads the same message multiple times.
- Use `X-GM-THRID` for thread IDs (stable, Gmail-native). Fall back to `References`/`In-Reply-To` header parsing for non-Gmail providers.
- Use `X-GM-LABELS` for label mapping.
- Throttle initial backfill to respect Gmail's IMAP bandwidth limits (~250MB/day).

**Auth:**
- Phase 1: App password (Gmail Settings → Security → 2-Step Verification → App Passwords). No OAuth, no Google Cloud Console setup.
- Phase 2: OAuth 2.0 via browser flow in `zmail configure`. Required for smooth open-source onboarding.

**Provider abstraction:**
```
ImapProvider (interface)
├── GmailProvider         ← All Mail strategy, X-GM-* extensions
├── GenericImapProvider   ← standard IMAP, header-based threading
└── (others follow GenericImapProvider)
```

---

### ADR-012: Attachment Extraction — Agent-Friendly Markdown Output

**Status: Implemented.**

**Decision:** Attachments are captured during sync (raw files written to disk, metadata inserted into DB), and extraction to text happens on-demand when first read. Extracted text is cached in the `attachments.extracted_text` column and reused on subsequent reads. This keeps sync fast while making extracted content immediately available to agents.

**Extraction libraries (TypeScript-native, Node-compatible):**

| Format | Library | Output | Status |
|---|---|---|---|
| PDF | `@cedrugs/pdf-parse` | Text | Working — tested on IRS W-9, NetJets invoices, RFC docs |
| DOCX | `mammoth` | Markdown | Working — tested on multi-page documents |
| XLSX/XLS | `exceljs` | CSV | Working — tested on Microsoft sample data, NetJets flight activity |
| CSV | passthrough | CSV | Working |
| HTML | `turndown` | Markdown | Working — strips tags, preserves structure |
| TXT | passthrough | Text | Working |
| Other | — | null | Returns null (unsupported) |

**Library notes:**
- `@cedrugs/pdf-parse` (fork of pdf-parse v1 API): works in Node. The original `pdf-parse` v2 depends on `pdfjs-dist` which requires `DOMMatrix` / canvas — not available in headless Node.
- `exceljs`: handles real `.xlsx` files correctly. The SheetJS community edition (`xlsx` v0.18.5) cannot parse modern XLSX files.
- `mammoth`: converts DOCX to markdown natively, best-in-class for Word docs.

**Storage:**
- Raw attachment files: `maildir/attachments/<message_id>/<filename>` on volume
- Extracted text cached in `attachments.extracted_text` column (populated on first read)
- Future: sibling-file caching (`<filename>.md` or `<filename>.csv`) for faster reads without DB lookup

**On-demand extraction flow:**
1. `zmail attachment read <id>` or MCP `read_attachment(id)` called
2. Check DB `extracted_text` column
3. If populated: return cached content
4. If null: read raw file → run extractor → update DB → return text

**Agent interface:**
```
CLI:  zmail attachment list <message_id>        → JSON array of attachments
      zmail attachment read <attachment_id>      → markdown/CSV text (stdout)
      zmail attachment read <attachment_id> --raw → raw binary (stdout)

MCP:  list_attachments(messageId)              → JSON array
      read_attachment(attachmentId)              → markdown/CSV string
```

**Agent workflow example:**
```
1. zmail search "agreement from fred"      → finds message abc123
2. zmail read abc123                       → body shows attachments: [{id:7, filename:"Agreement.pdf"}]
3. zmail attachment read 7                 → outputs markdown text of the PDF
4. Agent summarizes the agreement
```

**Test coverage:** `tests/attachments/extractors.test.ts` — 9 tests covering all supported formats plus unsupported format handling. Fixtures in `tests/attachments/fixtures/` include real-world files (IRS W-9, RFC 791, Microsoft sample data).

---

### ADR-013: Initial Sync Strategy — Iterative Windows, Most Recent First

**Decision:** Sync in expanding reverse-chronological windows so recent email is searchable within seconds, not after a full archive download.

**Window schedule:**
```
Window 1:  last 24 hours     → target: searchable within ~30 seconds
Window 2:  previous 6 days   → target: searchable within ~2-5 minutes
Window 3:  previous 3 weeks
Window 4:  previous 2 months
Window 5:  remaining to target date
```

Each window fetches, parses, and indexes completely before the next begins. IMAP `UID SEARCH SINCE <date>` defines each window; UIDs are fetched highest-first within the window so most recent messages arrive first.

**Default backfill:** 1 year. Set via CLI: `zmail sync --since 7d | 5w | 3m | 2y` (default: 1y). Override default via `sync.defaultSince` in config.json.

**Resume behavior:** When running `zmail sync` with a longer date range than previously synced, it automatically resumes from the oldest synced date and continues backward. For example, if you've synced 7 days and run `zmail sync --since 14d`, it will only fetch messages from days 8-14, skipping the already-synced first 7 days entirely.

**Crash recovery:** Each window is atomic — if sync crashes mid-window, it restarts from the beginning of the incomplete window. No partial state to reconcile.

**Progress estimation:** `(today − earliest_synced_date) / (today − target_date) × 100`. Always accurate because the earliest fully-synced date is known precisely.

**Sync state schema:**
```sql
sync_windows  (id, phase, window_start, window_end, status,
               messages_found, messages_synced, started_at, completed_at)
sync_summary  (earliest_synced_date, latest_synced_date, total_messages,
               last_sync_at, is_running, owner_pid)
```

---

### ADR-014: Web UI — Hono + HTMX, Server-Rendered

**Status: Deferred.** The web UI has been removed. CLI and MCP are the supported interfaces. Onboarding is via `zmail setup` and AGENTS.md. If a web UI is reintroduced later, this ADR describes the intended design.

**Decision (historical):** The service was to include a web UI for onboarding, sync status, and test search. Built with Hono (Bun-native HTTP framework) + HTMX. No client-side build step, no bundler, no framework.

**Rationale:** This is a single-user admin UI. Server-rendered HTML with HTMX polling/SSE for live sync status is faster to build and easier to maintain than a React SPA. Hono runs natively on Bun alongside the MCP server — same process, different routes.

**Service surfaces (historical):**
```
Single Bun process
├── /           Web UI (Hono + HTMX)
├── /mcp        MCP server endpoint
└── background  Sync daemon (runs as async task in same process)
```

**Onboarding flow (historical):** `/setup` → Sign in with Google, IMAP app password, live sync status, test search. `/dashboard` → Sync status + search. Current onboarding: `zmail setup` (CLI) and AGENTS.md.

---

### ADR-015: Web UI Auth — Google OAuth

**Status: Deferred.** Web UI has been removed; this ADR is retained for context if a web UI is reintroduced.

**Decision (historical):** The web UI was to be protected by Google OAuth sign-in.

**Rationale:** Two benefits in one: (1) Protects the admin UI without a separate password system. (2) Establishes Google OAuth infrastructure for potential Phase 2 IMAP auth. Implementation: standard Google OAuth 2.0 PKCE flow, session as signed cookie.

---

### ADR-016: Sync Performance — Bandwidth-Bound as Goal

**See also:** [SYNC.md](./SYNC.md) — Performance optimizations and current bottlenecks.

**Decision:** Sync speed is of paramount importance. The target is to saturate I/O: the sync pipeline should be limited by available network bandwidth (or disk throughput when writing), not by CPU, concurrency limits, or unnecessary serialization. If IMAP sync is not bound by available bandwidth, it has room for improvement.

**Rationale:** Users with large mailboxes need backfill and incremental sync to finish as fast as the provider and link allow. Being bandwidth-bound means we have eliminated avoidable bottlenecks (e.g. single-connection fetch, one-at-a-time parsing, blocking on index writes). This principle guides choices around parallel fetch, connection reuse, pipelining, and batching so that the only remaining limit is physics — how much data the network and disk can move.

**Result:** When optimizing sync, the question to ask is: are we maxing out the pipe? If not, the design or implementation should be improved until we are.

---

### ADR-017: Sync Design — Priority, Batching, and Backoff

**See also:** [SYNC.md](./SYNC.md) — Current batching implementation and performance results.

**Decision:** Sync is timestamp- and folder-priority focused, avoids chatty-protocol slowdowns, and uses smart backoff when the provider complains.

**Priority**
- **Most recent first:** Newest messages and most important folders (e.g. INBOX, [Gmail]/All Mail) get highest priority so recent mail is searchable quickly. This aligns with ADR-013’s windowed strategy but applies continuously: within and across folders, prefer recent-by-date and high-value folders.
- **Goal:** Users see today’s mail and key folders synced before deep archive backfill.

**Avoid chatty protocols (or parallelize if we must)**
- IMAP can be slow when used in a chatty way (many small round-trips, one message per request). Learn from download managers (e.g. Steam, browser downloaders): batch fetches, multiple parallel streams, and large reads so the pipeline is limited by bandwidth, not RTT or command count.
- **Apply to email sync:** Prefer batching (e.g. ranges of UIDs or chunked FETCH), concurrent connections where the provider allows, and pipelining to minimize round-trips per byte. The aim is to saturate the network, not to tickle it with small requests.
- **When the protocol stays chatty:** If we cannot avoid chatty usage (e.g. provider or protocol limits on batch size), run many workers in parallel. Many concurrent connections or workers each doing small requests can still saturate the link; latency is amortized across parallelism. Prefer batching first, then scale out with workers.
- **Rationale:** Chatty protocols leave bandwidth on the table when run single-threaded; batching reduces chattyness, and parallelism is the fallback to become bandwidth-bound (ADR-016) when batching alone is insufficient.

**Smart, fast backoff**
- When the IMAP provider signals backpressure (e.g. rate limit, “try again”, connection throttling, errors), back off so we don’t hammer the server — but resume aggressively when the provider is happy again.
- **Smart:** Back off in proportion to the signal (e.g. respect Retry-After or error type; avoid overly long sleeps when a short pause suffices).
- **Fast:** Once the provider allows, ramp back to full throughput quickly. Avoid conservative backoff that keeps sync slow long after the provider has recovered.
- **Rationale:** We want to be good citizens and avoid bans, while still achieving saturation whenever the provider and network allow.

**Result:** Sync design should explicitly address: (1) ordering work by timestamp and folder importance, (2) batching and parallelism to avoid chatty IMAP and saturate the link, and (3) backoff that is both respectful and fast to recover.

---

### ADR-018: Sync Observability — Synchronous Run + Observable Progress

**Decision:** Sync runs **synchronously**. Progress is observable in two ways so agents (or humans) can infer status and speed without introducing a job queue:

1. **Periodic progress to stdout** — During sync, emit progress lines at a regular cadence (e.g. every N messages or every few seconds): messages fetched so far, bytes downloaded, elapsed time, throughput (msg/min). When the run finishes, always emit a final metrics block (messages new/fetched, bytes, bandwidth, msg/min, duration).
2. **Pollable progress** — Write current-run progress to a well-known place (e.g. a progress file under ZMAIL_HOME/data or fields in sync_summary / a small table) so another agent or process can poll (e.g. `zmail status` or reading a file) and report status even when the runner does not stream stdout.

We do **not** introduce async job IDs or a job queue for sync unless we later need multiple concurrent syncs or very long-running jobs that must outlive a single CLI invocation.

**Rationale:** Agent-first (VISION) means the primary consumers of the CLI are agents (Claude Code, OpenClaw, Pi, etc.). They invoke `zmail sync` as a subprocess. Some environments stream stdout, so periodic progress lines give live feedback; others only return output on exit, so the final metrics block is still available. A pollable source (file or DB + `zmail status`) lets a *different* agent or process observe “sync in progress” without depending on streaming. Keeping sync synchronous avoids job storage, lifecycle, and daemon complexity for the common case (single-user, single sync at a time).

**Result:** Sync is fast, accurate, and reports how fast it was (ADR-016/017). It also makes progress observable so other agents can inspect and report status as it goes.

---

### ADR-019: Data Duplication — What Lives in SQLite vs. Raw Store

**Decision:** The `messages` table stores `body_text` but **not** `body_html`. HTML content is read on demand from the raw `.eml` file via `raw_path`.

**Data residency by layer:**

| Data | Canonical store | Also in SQLite? | Why |
|---|---|---|---|
| Raw email (MIME) | `.eml` file in `maildir/` | No | Canonical artifact — everything rebuilds from this |
| `body_text` | `.eml` file | **Yes** — `messages.body_text` | Required for FTS5. The external-content FTS5 table (`content='messages'`) reads from this column for indexing and `snippet()` generation. Removing it would break full-text search. |
| `body_html` | `.eml` file | **No** | Not indexed, not searched. Parse from `.eml` on demand when rendering is needed. |
| Embeddings | (deferred) LanceDB | No | Current implementation is FTS-only; vector layer removed (OPP-019). |
| Metadata (from, to, subject, date, labels) | `.eml` headers | **Yes** — `messages.*` columns | Needed for filtering, sorting, and display without parsing `.eml` on every query. |

**Rationale:** The guiding principle is: the raw `.eml` store is the durable artifact; SQLite is a rebuildable index (ADR-002). Data should only be duplicated into SQLite when it is required for indexing or high-frequency queries. `body_text` qualifies because FTS5 cannot function without it. `body_html` does not — it's never searched and can be parsed from the `.eml` on the rare occasions it's needed. Metadata columns (from, to, subject, date) qualify because they're used in WHERE/ORDER BY/JOIN on nearly every query.

**Consistency:** Email is immutable after receipt. Both the `.eml` file and the SQLite row are written in the same sync operation. There is no update path where they could drift. If the SQLite index is ever suspect, it can be rebuilt from the `.eml` store without touching IMAP.

---

### ADR-020: Sync and Indexing — Concurrent, Single-Threaded, Resilient

**See also:** [SYNC.md](./SYNC.md) — Detailed sync implementation, optimization history, and performance analysis.

**Current implementation:** Sync only. Embedding/indexing and hybrid search have been removed (FTS-first architecture, [OPP-019](opportunities/OPP-019-fts-first-retire-semantic-default.md)). The following describes the prior design; it may be restored or reimplemented later.

**Decision (prior design):** `zmail sync` and `zmail refresh` are the user-facing sync commands. Both launched sync and indexing concurrently via `Promise.all` in a single thread:

1. **Sync** (bandwidth-bound): IMAP fetch → write `.eml` to maildir → insert into SQLite. Optimized to saturate network bandwidth (ADR-016/017).
2. **Indexing** (removed): Had claimed pending messages from SQLite → generate embeddings via OpenAI → write to LanceDB. Embedding API responses were cached on disk (by model and input hash). Cache lived under `ZMAIL_HOME/data/embedding-cache`.

```
zmail sync [--since <spec>]  (backward sync)
└── Sync:     IMAP → maildir + SQLite  (bandwidth-bound)
              - Resumes from oldest synced date
              - Uses UID filtering to skip already-synced messages
              - Searches before oldest synced date when all messages from a day are synced

zmail refresh  (forward sync)
└── Sync:     IMAP → maildir + SQLite  (bandwidth-bound)
              - Uses UID range search (UID ${last_uid + 1}:*)
              - Only fetches new messages since last sync
```

**Single-threaded.** Sync runs in one process; embedding/indexing pipeline has been removed (OPP-019).

This replaces an earlier multi-worker design that used Bun Workers. That design was abandoned due to SQLite single-writer contention and Bun Worker stability issues. The async-pipelined approach achieves the same throughput for I/O-bound work with a much simpler execution model.

**DB-backed indexing queue (removed).** The prior design tracked indexing per-message via an `embedding_state` column (pending → claimed → done/failed). That column and the indexer have been removed.

**PID-based advisory locks.** Each subsystem has a singleton status row (`sync_summary`, `indexing_status`) with `is_running` and `owner_pid` columns. Before starting:

1. Read `is_running` and `owner_pid`.
2. If locked and `owner_pid` is alive (`kill(pid, 0)`), exit early — another instance is running.
3. If locked but `owner_pid` is dead, take over the lock (log a warning, reset stale state).
4. On completion or error, clear `is_running` and `owner_pid`.

This replaces timestamp-based staleness detection. PID checks are instantaneous and deterministic — no arbitrary timeout windows, no false positives from slow runs, no false negatives from clock skew.

**Availability:** Synced messages are immediately available for FTS5 search and direct fetch.

**Search:** FTS5 full-text search only (no hybrid/semantic in current implementation).

**Observability:**
- Sync tracks progress in the DB (`sync_summary`).
- `zmail status` reports current state.
- Agents and remote clients can poll status at any time without depending on stdout.
- Stdout progress lines are emitted periodically for environments that stream output.

**No standalone indexing command.** There is no `zmail index` or backfill tool. `zmail sync` and `zmail refresh` are the only entry points for data ingestion — one command, one process (indexing/embedding pipeline removed).

---

### ADR-021: Schema Drift Handling — Auto-Rebuild from Maildir

**Decision:** On CLI startup, the app checks `user_version` against the current schema version. If the DB has an older version, the app automatically rebuilds the index from the local maildir cache: deletes the DB (plus any `-shm`/`-wal` WAL files), creates a fresh DB, and re-indexes all `.eml` files from `maildir/cur/`. No manual resync from IMAP is required.

**Rationale:** This project intentionally avoids in-app migrations for existing DBs. `CREATE TABLE IF NOT EXISTS` keeps fresh bootstraps simple but does not mutate older tables. The raw maildir is the durable artifact (ADR-002); rebuilding from it is faster than re-syncing from IMAP and avoids credential/network dependency during schema upgrades.

**Sidecar metadata:** EML files lack IMAP-only data (e.g. Gmail labels/categories). During sync, a companion `.meta.json` sidecar is written alongside each `.eml` (same basename, e.g. `100_msg.meta.json`) containing a JSON catch-all for non-standard metadata (`{ "labels": [...] }`). Rebuild reads sidecars to restore label-based noise classification and any future metadata. The sidecar format is extensible — add new fields without creating additional files.

**Result:** Fresh environments bootstrap directly from source schema. Stale local DBs trigger an automatic rebuild from maildir (typically under 20s for moderate mailboxes). If maildir is empty or missing, rebuild completes with 0 messages and the user can run `zmail sync` to fetch from IMAP.

---

---

### ADR-022: CLI Output Format — JSON Default for Structured Commands, Text for Progressive/Content Commands

**Decision:** CLI output format is determined per-command based on whether the output is structured data, progressive status, or raw content — not by TTY detection.

**Format matrix:**

| Command | JSON | Text | Default | Notes |
|---|---|---|---|---|
| `search` | yes (`--json`) | yes (`--text`) | **JSON** | Structured results; agent primary workflow |
| `who` | yes (`--json`) | yes (`--text`) | **JSON** | Structured people records |
| `attachment list` | yes (`--json`) | yes (`--text`) | **JSON** | Structured list with IDs agents need to follow up |
| `status` | yes (`--json`) | yes (default) | **text** | Human-readable status lines; agents parse text fine |
| `stats` | yes (`--json`) | yes (default) | **text** | Summary stats; no iteration needed |
| `read` / `message` | no | yes (default) | **text** | Body IS the content; wrapping markdown in JSON adds noise |
| `thread` | no | yes (default) | **text** | Same as `read` — multi-message view; was previously always JSON (changed) |
| `sync` | no | yes (default) | **text** | Progressive output as sync runs; JSON would be worse |
| `refresh` | no | yes (default) | **text** | Same as `sync` |
| `attachment read` | no | yes (default) | **text** | Raw content / extracted text; wrapping in JSON is clumsy |
| `mcp` | n/a | n/a | n/a | stdio protocol |

**Key principles driving these decisions:**

1. **Machine-parsable by default** for commands whose output agents need to consume structurally (search results, people records, attachment lists). JSON is the format.
2. **Token-efficient** — JSON is not imposed where it adds wrapper noise without value (e.g. a markdown email body inside a JSON string field).
3. **Self-documenting** — hints and guidance remain in output (in the JSON payload for JSON commands; in stdout for text commands) so agents learn as they go.
4. **No TTY detection** for format switching. TTY detection is fragile and creates inconsistency between interactive and scripted use. Format defaults are fixed per command; users/agents opt out with `--text` or `--json`.

**Flag naming — `--text` not `--table`:**

The override flag is `--text` (not `--table`) because several text-format commands (`status`, `sync`) don't produce tables — they produce status lines. `--text` is the general term for human-readable non-JSON output.

**`thread` change — text by default:**

`thread` was previously hardcoded to always output JSON. This is changed to match `read`/`message`: text by default. The body content of emails is the value, and wrapping markdown bodies in JSON strings offers no agent benefit over a readable multi-message text view. If an agent needs to iterate over message IDs from a thread, it can use `search` with a thread filter.

**`status` and `stats` — text default with `--json` opt-in:**

Agents today parse the text output of `status` without difficulty. Text stays the default. `--json` is added as an opt-in for automated status checks (e.g. "is sync done?" polling).

**Rationale:** zmail is agent-first (ADR-005). The primary consumers are agents (Claude Code, Cursor, etc.) running CLI commands as subprocesses. Agents need structured output for search results and lists they'll iterate or pass downstream — JSON is correct there. For content retrieval (`read`, `thread`, `attachment read`) and progress reporting (`sync`, `refresh`, `status`), text is not a barrier to agent use and avoids JSON encoding overhead on large content.

---

### ADR-023: SQLite Access — File-Backed Native + Async Facade + Install-Time Rebuild

**Decision:** Keep **file-backed** SQLite using **`better-sqlite3`** (native addon). Do **not** use an in-process model that loads the entire database file into JS/WASM heap for production (e.g. sql.js `readFile` → `Database(uint8)` / `export()` persistence), which would make RSS scale with DB size — unacceptable for very large mailstores.

**Application API:** Expose a narrow **`SqliteDatabase`** interface (`exec`, `prepare` → async `run` / `get` / `all`, `close`) implemented by a small adapter around `better-sqlite3`. All CLI, sync, search, MCP, and ask code paths **`await`** DB operations so the surface is consistently async even though the underlying driver is synchronous.

**Packaging / ABI:** `package.json` **`postinstall`** runs **`npm rebuild better-sqlite3`** for the **current** Node when `node_modules` is present. That aligns the prebuilt or freshly compiled `.node` with the runtime’s **`NODE_MODULE_VERSION`**, reducing `ERR_DLOPEN_FAILED` after **`npm install -g`** when install-time Node ≠ runtime Node. Documented fallback: run **`npm rebuild better-sqlite3`** with the same `node` that runs `zmail`.

**Schema changes:** Unchanged philosophy (ADR-021): bump **`SCHEMA_VERSION`**, delete stale DB files, **rebuild from maildir** — no row-level migration from old DB files when the driver or schema changes.

**Deferred:** WASM SQLite with a custom file VFS for Node remains an alternative if native rebuild stops being sufficient; FTS5 and file-backed behavior would need to be re-validated before switching.

**See also:** [OPP-024](opportunities/archive/OPP-024-sqlite-node-abi-mitigation.md) — opportunity log for the ABI / global-install mitigation.

---

## Open Questions

_(none — all major decisions resolved)_
