# zmail — Agent Guide

This file provides context for AI coding agents (Claude Code, Cursor, OpenClaw, etc.) working in this repository.

## Single source of truth

**There is exactly one canonical source for each kind of information.** Do not duplicate facts in multiple files; point to the canonical doc instead. When updating documentation, update the single source and fix or remove any copies. Canonical sources: `docs/ARCHITECTURE.md` (technical decisions and storage layout), `docs/VISION.md` (product vision), `.env.example` (environment variables), this file (project structure and agent conventions).

## What this project is

**zmail** is an agent-first email system. It syncs email from IMAP providers, indexes it locally, and exposes it as a queryable dataset via a CLI binary and MCP server.

The goal is not another email client. The goal is to make email a tool-accessible, searchable dataset for AI agents.

## Key documents

- [`docs/VISION.md`](docs/VISION.md) — product vision and principles
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — all technical decisions with rationale (read this before making architectural choices)
- [`docs/OPPORTUNITIES.md`](docs/OPPORTUNITIES.md) — product improvement ideas from real usage

## Tech stack

| Concern | Choice |
|---|---|
| Runtime | Bun |
| Language | TypeScript |
| HTTP framework | Hono |
| Database | SQLite via `bun:sqlite` |
| Full-text search | SQLite FTS5 |
| Vector search | LanceDB embedded |
| IMAP | imapflow |
| Web UI | Hono + HTMX |
| Distribution | `bun build --compile` → native binary |

## Project structure

```
src/
  cli/          zmail binary entrypoint and subcommands
  sync/         IMAP sync engine, provider implementations
  db/           SQLite schema, migrations, query helpers
  search/       FTS5 and semantic search
  attachments/  Document extraction → markdown
  mcp/          MCP server tools and handlers
  web/          Hono web UI routes (onboarding, status, search)
  lib/          Shared utilities
docs/
  VISION.md
  ARCHITECTURE.md
```

## Search and indexing testing

When you are asked to search for emails (or to verify search results), **use the standard search interface** — the same code path as the web search route ([`src/web/routes/search.ts`](src/web/routes/search.ts)). That way we exercise the real indexing and search pipeline for speed and accuracy.

- **Do not peek behind the curtain:** do not query the database or filesystem directly for search. Use the CLI or the search API that the web uses (`search(db, { query })` from `~/search`), or trigger searches via the running service.
- Direct DB or filesystem access is implicitly granted when debugging (e.g. figuring out why a search missed an expected hit) or when the user explicitly asks you to.

## Development conventions

- **Read `docs/ARCHITECTURE.md` before making any storage, sync, or interface decisions.** All major decisions are recorded there with rationale.
- Prefer `bun:sqlite` over any external SQLite library — it's built in and faster.
- All storage access for raw files goes through a `StorageAdapter` interface (`LocalAdapter` default, `S3Adapter` optional).
- Never commit email data, credentials, or `.db` files — see `.gitignore`.
- **Local DB at dev time:** No migrations; schema is applied on DB creation. To apply schema changes or reset state, delete `data/` or `data/zmail.db` and re-run. See [`.cursor/skills/db-dev/`](.cursor/skills/db-dev/) for the standard skill.
- The CLI (`zmail <command>`) and MCP server share the same underlying logic. Commands return structured JSON suitable for agent consumption.
- Attachment extraction uses per-format libraries (`pdfjs-dist`, `mammoth`, `xlsx`) behind a `DocumentExtractor` interface.

## Running locally

```bash
bun install
bun run dev          # start the service (web UI + MCP server)
bun run sync         # run sync daemon
bun run build        # compile native binary
```

## Running sync

Canonical sync behavior: [`.env.example`](.env.example) (SYNC_MAILBOX, SYNC_EXCLUDE_LABELS), [db-dev](.cursor/skills/db-dev/) (reset before sync if schema changed).

- **Env:** `IMAP_USER` and `IMAP_PASSWORD` required. Optional: `SYNC_MAILBOX`, `SYNC_EXCLUDE_LABELS`, `SYNC_FROM_DATE`.
- **Default:** Gmail → mailbox `[Gmail]/All Mail`; exclude labels Trash and Spam. Override in `.env`.
- **CLI:** `bun run src/index.ts sync` or `sync --since 7d` (5w, 3m, 2y). Metrics (messages, bytes, bandwidth, msg/min) printed at end.
- **After full reset (db-dev):** First sync is full; later syncs incremental. No migrations — if schema changed, reset then sync.

## Environment variables

Canonical list and descriptions: [`.env.example`](.env.example). Summary: `IMAP_*`, `SYNC_FROM_DATE`, `SYNC_MAILBOX`, `SYNC_EXCLUDE_LABELS`, `GOOGLE_*`, `AUTH_SECRET`, `PORT`, `DATA_DIR`, optional `OPENAI_API_KEY`.
