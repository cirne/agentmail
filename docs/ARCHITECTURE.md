# Architecture & Design Decisions

This document tracks concrete architectural decisions made during design and development.
See [VISION.md](./VISION.md) for the product vision and goals.

---

## Decision Log

### ADR-001: Phase 1 Scope — IMAP Sync → SQLite → MCP Server

**Decision:** The minimum useful Phase 1 system is:

```
IMAP provider → raw email store → SQLite FTS5 index → MCP server
```

**Rationale:** If you can search your own email from an agent (Cursor, Claude Desktop) in natural language, the core value is proven. Everything else — filesystem interface, semantic embeddings, replacement SMTP mode — comes later.

**Deferred:** Filesystem (FUSE) interface, SMTP ingress, semantic/vector search, multi-user.

---

### ADR-002: Storage — Embedded + Persistent Volume Throughout

```
Container
└── /data  (persistent volume — survives redeploys)
    ├── maildir/        ← raw .eml files
    ├── zmail.db    ← SQLite: metadata, FTS5 index, sync state
    └── vectors/        ← LanceDB embedded
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

**Decision:** Sync state is tracked per folder as `{ folder, uidvalidity, last_uid }`.

**Rationale:** IMAP UIDs are stable, monotonically increasing identifiers. Checkpointing the last-seen UID per folder allows sync to resume exactly where it left off after a redeploy, crash, or restart — without re-downloading previously synced messages. `UIDVALIDITY` detects the rare case where a folder was wiped and recreated, triggering a full re-sync of that folder.

**Result:** The raw email store (Maildir or R2) is the durable artifact. The index is always rebuildable from the raw store without touching IMAP.

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
zmail sync [--since <spec>]     ← sync + concurrent indexing
zmail search <query> [flags]    ← header-first search with mode/detail controls
zmail status                    ← sync/indexing/search readiness
zmail stats                     ← DB stats (volume + top senders/folders)
zmail thread <id>               ← fetch full thread JSON
zmail message <id>              ← fetch single message JSON
zmail mcp                       ← start MCP server (stdio)
```

**Rationale:** Agents like Claude Code and OpenClaw can invoke shell commands directly. A subprocess call to `zmail search` is faster than an MCP HTTP round-trip, requires no running server, and has no port management. The CLI returns structured JSON so agents can consume output directly.

MCP remains the right interface for remote/hosted deployments where the index lives on a server the agent can't shell into.

Both modes hit the same SQLite index. The binary is the same artifact.

---

### ADR-006: Storage Layers

**Decision:** Four distinct storage layers, each optimized for its access pattern:

| Layer | Phase 1 + 2 | Phase 3 (hosted SaaS, if ever) |
|---|---|---|
| Raw email files | Maildir on persistent volume | S3 / DO Spaces |
| Structured metadata + FTS | SQLite via `bun:sqlite` | Postgres |
| Semantic / vector search | LanceDB embedded on volume | LanceDB → S3 |

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

**Vector / semantic search:** LanceDB embedded. TypeScript-native, no server required, stores data on the same volume as everything else. S3 backend available for Phase 3 if needed. Preferred over Chroma because it stays fully embedded through Phase 2.

**Embedding generation:** OpenAI API for Phase 1 (simplest, negligible cost for personal use). Ollama (local models) supported for open-source users who want full privacy.

---

### ADR-007: Security Baseline

**Decisions:**
- **IMAP auth:** App passwords (not OAuth) for Phase 1 — simpler, revocable, no token refresh complexity.
- **Secrets:** All credentials (IMAP password, MCP auth token) passed via environment variables. Never committed to the repo.
- **MCP auth:** Static bearer token set at deploy time. Required — the MCP endpoint must not be publicly accessible without auth.
- **Storage encryption:** Fly.io volumes are encrypted at rest by default. Raw email is never transmitted without TLS.

---

### ADR-008: Language & Runtime — TypeScript + Bun

**Decision:** TypeScript compiled with Bun (`bun build --compile`).

**Rationale:**
- `bun build --compile` produces a single self-contained native binary — no runtime required on the user's machine. Distributable via Homebrew, `curl | sh`, GitHub releases.
- Bun has **built-in SQLite** (`bun:sqlite`) with native bindings — no `better-sqlite3`, no native addon compilation.
- Fast startup time (comparable to Go) — critical for CLI tool-use where agents shell out on every call.
- First-class TypeScript without a separate build step in development.
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

**Decision:** Attachments are extracted during sync, converted to markdown, and indexed in SQLite FTS5 alongside message body text. Agents can list, read, and search attachment content via the same tool interface as messages.

**Extraction libraries (TypeScript-native, Bun-compatible):**

| Format | Library | Notes |
|---|---|---|
| PDF | `pdfjs-dist` | Mozilla PDF.js — mature, well-maintained |
| DOCX | `mammoth` | HTML or markdown output, best-in-class |
| XLSX | `xlsx` (SheetJS) | JSON/CSV output, rendered as markdown tables |
| PPTX | `officeparser` | Text extraction |
| HTML | `turndown` | HTML → markdown |
| CSV, TXT | native | Trivial |
| Images | Vision API (GPT-4o / Claude) | OCR and description |

**Rationale:** `markitdown-ts` (TypeScript port of Microsoft's MarkItDown) exists but is immature (105 stars). Individual libraries are battle-tested. A `DocumentExtractor` interface with per-format implementations keeps the abstraction clean.

**Storage:**
- Raw attachment files: `maildir/attachments/<message_id>/<filename>` on volume
- Extracted markdown text: stored in `attachments` table in SQLite
- FTS5 index covers attachment content alongside message body — `search_mail("indemnification clause")` matches text *inside* a PDF

**Agent interface:**
```
CLI:  zmail attachments list <thread_id>
      zmail attachments read <attachment_id>   → markdown output

MCP:  list_attachments(thread_id?, filters?)
      read_attachment(attachment_id)               → markdown string
      search_attachments(query)
```

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

**Default backfill:** 1 year. Set via CLI: `zmail sync --since 7d | 5w | 3m | 2y` (default: 1y). Override default via `DEFAULT_SYNC_SINCE` env var.

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

**Decision:** The service includes a web UI for onboarding, sync status, and test search. Built with Hono (Bun-native HTTP framework) + HTMX. No client-side build step, no bundler, no framework.

**Rationale:** This is a single-user admin UI. Server-rendered HTML with HTMX polling/SSE for live sync status is faster to build and easier to maintain than a React SPA. Hono runs natively on Bun alongside the MCP server — same process, different routes.

**Service surfaces:**
```
Single Bun process
├── /           Web UI (Hono + HTMX)
├── /mcp        MCP server endpoint
└── background  Sync daemon (runs as async task in same process)
```

**Onboarding flow (new instance):**
```
/setup
  → Sign in with Google        ← protects UI, establishes OAuth infra
  → Enter IMAP app password    ← Phase 1 auth
  → Live sync status view      ← windows progress, earliest date synced
  → Test search                ← confirm system is working
/dashboard (configured instances)
  → Sync status + progress
  → Search interface
```

---

### ADR-015: Web UI Auth — Google OAuth

**Decision:** The web UI is protected by Google OAuth sign-in.

**Rationale:** Two benefits in one:
1. Protects the admin UI without requiring a separate password system.
2. Establishes the Google OAuth app registration and token infrastructure that Phase 2 IMAP auth will reuse. When Gmail OAuth scope is added, the consent screen extends the same flow — no separate OAuth plumbing.

**Implementation:** Standard Google OAuth 2.0 PKCE flow. Session stored as a signed cookie. Only the authenticated Google account (the owner) can access the UI.

---

### ADR-016: Sync Performance — Bandwidth-Bound as Goal

**Decision:** Sync speed is of paramount importance. The target is to saturate I/O: the sync pipeline should be limited by available network bandwidth (or disk throughput when writing), not by CPU, concurrency limits, or unnecessary serialization. If IMAP sync is not bound by available bandwidth, it has room for improvement.

**Rationale:** Users with large mailboxes need backfill and incremental sync to finish as fast as the provider and link allow. Being bandwidth-bound means we have eliminated avoidable bottlenecks (e.g. single-connection fetch, one-at-a-time parsing, blocking on index writes). This principle guides choices around parallel fetch, connection reuse, pipelining, and batching so that the only remaining limit is physics — how much data the network and disk can move.

**Result:** When optimizing sync, the question to ask is: are we maxing out the pipe? If not, the design or implementation should be improved until we are.

---

### ADR-017: Sync Design — Priority, Batching, and Backoff

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
2. **Pollable progress** — Write current-run progress to a well-known place (e.g. a progress file under DATA_DIR or fields in sync_summary / a small table) so another agent or process can poll (e.g. `zmail status` or reading a file) and report status even when the runner does not stream stdout.

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
| Embeddings | LanceDB (`data/vectors/`) | No | Vector-only (no text stored in LanceDB). Rebuildable from `body_text`. |
| Metadata (from, to, subject, date, labels) | `.eml` headers | **Yes** — `messages.*` columns | Needed for filtering, sorting, and display without parsing `.eml` on every query. |

**Rationale:** The guiding principle is: the raw `.eml` store is the durable artifact; SQLite is a rebuildable index (ADR-002). Data should only be duplicated into SQLite when it is required for indexing or high-frequency queries. `body_text` qualifies because FTS5 cannot function without it. `body_html` does not — it's never searched and can be parsed from the `.eml` on the rare occasions it's needed. Metadata columns (from, to, subject, date) qualify because they're used in WHERE/ORDER BY/JOIN on nearly every query.

**Consistency:** Email is immutable after receipt. Both the `.eml` file and the SQLite row are written in the same sync operation. There is no update path where they could drift. If the SQLite index is ever suspect, it can be rebuilt from the `.eml` store without touching IMAP.

---

### ADR-020: Sync and Indexing — Concurrent, Single-Threaded, Resilient

**Decision:** `zmail sync` is the single user-facing command. Under the hood, it launches sync and indexing concurrently via `Promise.all` in a single thread:

1. **Sync** (bandwidth-bound): IMAP fetch → write `.eml` to maildir → insert into SQLite with `embedding_state = 'pending'`. Optimized to saturate network bandwidth (ADR-016/017).
2. **Indexing** (API-rate-bound): Claim pending messages from SQLite → generate embeddings via OpenAI → write to LanceDB → mark `embedding_state = 'done'`. Multiple embedding batches in-flight concurrently.

```
zmail sync
├── Sync:     IMAP → maildir + SQLite  (bandwidth-bound)
└── Indexing: SQLite → OpenAI → LanceDB  (API-rate-bound, async-pipelined)
    ├── batch 1 in-flight (OpenAI API call)
    ├── batch 2 in-flight (OpenAI API call)
    └── ... up to INDEXER_CONCURRENCY
```

**Single-threaded, async-pipelined architecture.** Both sync and indexing run in the same OS thread. The indexing orchestrator keeps N embedding batches in-flight concurrently via `Promise.all`/`Promise.race` — the OpenAI API is the bottleneck, not CPU, so async I/O saturates the rate limit without thread overhead. Only the main thread touches SQLite, eliminating cross-thread lock contention entirely.

This replaces an earlier multi-worker design that used Bun Workers. That design was abandoned due to SQLite single-writer contention and Bun Worker stability issues. The async-pipelined approach achieves the same throughput for I/O-bound work with a much simpler execution model.

**DB-backed indexing queue.** The `messages` table tracks indexing progress per-message via an `embedding_state` column:

```
pending → claimed → done
                  → failed
```

- `pending`: Newly synced, awaiting indexing. A partial index on this column makes queue polling fast.
- `claimed`: Atomically claimed by `claimBatch()` inside a transaction. Prevents double-processing.
- `done`: Embedding generated and written to LanceDB.
- `failed`: Embedding or upsert failed (logged, not retried automatically).

On startup, the indexer resets any `claimed` rows back to `pending` (stale claims from a crashed process).

**PID-based advisory locks.** Each subsystem has a singleton status row (`sync_summary`, `indexing_status`) with `is_running` and `owner_pid` columns. Before starting:

1. Read `is_running` and `owner_pid`.
2. If locked and `owner_pid` is alive (`kill(pid, 0)`), exit early — another instance is running.
3. If locked but `owner_pid` is dead, take over the lock (log a warning, reset stale state).
4. On completion or error, clear `is_running` and `owner_pid`.

This replaces timestamp-based staleness detection. PID checks are instantaneous and deterministic — no arbitrary timeout windows, no false positives from slow runs, no false negatives from clock skew.

**Progressive availability:** Synced messages are immediately available for FTS5/keyword search and direct fetch. Semantic search becomes available progressively as the indexer catches up — like a database serving queries while building an index in the background.

**Mode-aware search.** Search supports `auto|fts|semantic|hybrid`. `auto` selects a fast lexical path for clear metadata/keyword intent and uses hybrid for broader semantic intent. Hybrid still uses FTS5 + semantic search with Reciprocal Rank Fusion (RRF). Messages that have not been embedded remain discoverable through FTS.

**Observability:**
- Both subsystems track progress in the DB (`sync_summary`, `indexing_status`).
- `zmail status` reads both tables and reports current state.
- Agents and remote clients can poll status at any time without depending on stdout.
- Stdout progress lines are emitted periodically for environments that stream output.

**No standalone indexing command.** There is no `zmail index` or backfill tool. `zmail sync` is the only entry point for data ingestion and indexing — one command, one process.

**Rationale:** Embedding via an external API (OpenAI) adds ~50–100ms latency per message. Running this inline during sync would make sync API-bound instead of bandwidth-bound, violating ADR-016. Async-pipelined indexing lets each subsystem optimize for its own bottleneck while keeping the execution model simple: one thread, one process, no IPC.

---

### ADR-021: Schema Drift Handling — Detect and Rebuild Guidance

**Decision:** On DB open, the app performs a schema-drift preflight that checks required columns on existing tables. If required columns are missing, startup fails with a clear remediation message and recommends a full local data rebuild (`rm -rf data/` + resync).

**Rationale:** This project intentionally avoids in-app migrations for existing DBs. `CREATE TABLE IF NOT EXISTS` keeps fresh bootstraps simple but does not mutate older tables. Drift detection prevents opaque runtime SQLite errors (for example missing `messages.embedding_state`) and gives a deterministic recovery path.

**Result:** Fresh environments bootstrap directly from source schema, while stale local DBs fail fast with actionable rebuild instructions instead of partial runtime failures.

---

## Open Questions

_(none — all major decisions resolved)_
