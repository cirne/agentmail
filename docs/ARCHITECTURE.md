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
    ├── agentmail.db    ← SQLite: metadata, FTS5 index, sync state
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
2. **MCP server** (`agentmail mcp`) — for remote/hosted deployments

**CLI commands:**
```
agentmail configure        ← interactive setup (IMAP credentials, sync config)
agentmail sync             ← run / manage background sync daemon
agentmail search <query>   ← full-text search, returns JSON
agentmail thread <id>      ← fetch full thread
agentmail message <id>     ← fetch single message
agentmail mcp              ← start MCP server
```

**Rationale:** Agents like Claude Code and OpenClaw can invoke shell commands directly. A subprocess call to `agentmail search` is faster than an MCP HTTP round-trip, requires no running server, and has no port management. The CLI returns structured JSON so agents can consume output directly.

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
- Phase 2: OAuth 2.0 via browser flow in `agentmail configure`. Required for smooth open-source onboarding.

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
CLI:  agentmail attachments list <thread_id>
      agentmail attachments read <attachment_id>   → markdown output

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

**Default backfill:** 1 year. Configurable via `SYNC_FROM_DATE` env var.

**Crash recovery:** Each window is atomic — if sync crashes mid-window, it restarts from the beginning of the incomplete window. No partial state to reconcile.

**Progress estimation:** `(today − earliest_synced_date) / (today − target_date) × 100`. Always accurate because the earliest fully-synced date is known precisely.

**Sync state schema:**
```sql
sync_windows  (id, phase, window_start, window_end, status,
               messages_found, messages_synced, started_at, completed_at)
sync_summary  (earliest_synced_date, latest_synced_date, total_messages,
               last_sync_at, is_running)
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

## Open Questions

_(none — all major decisions resolved)_
