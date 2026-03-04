# agentmail — Agent Guide

This file provides context for AI coding agents (Claude Code, Cursor, OpenClaw, etc.) working in this repository.

## What this project is

**agentmail** is an agent-first email system. It syncs email from IMAP providers, indexes it locally, and exposes it as a queryable dataset via a CLI binary and MCP server.

The goal is not another email client. The goal is to make email a tool-accessible, searchable dataset for AI agents.

## Key documents

- [`docs/VISION.md`](docs/VISION.md) — product vision and principles
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — all technical decisions with rationale (read this before making architectural choices)

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

## Project structure (once scaffolded)

```
src/
  cli/          agentmail binary entrypoint and subcommands
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

## Development conventions

- **Read `docs/ARCHITECTURE.md` before making any storage, sync, or interface decisions.** All major decisions are recorded there with rationale.
- Prefer `bun:sqlite` over any external SQLite library — it's built in and faster.
- All storage access for raw files goes through a `StorageAdapter` interface (`LocalAdapter` default, `S3Adapter` optional).
- Never commit email data, credentials, or `.db` files — see `.gitignore`.
- The CLI (`agentmail <command>`) and MCP server share the same underlying logic. Commands return structured JSON suitable for agent consumption.
- Attachment extraction uses per-format libraries (`pdfjs-dist`, `mammoth`, `xlsx`) behind a `DocumentExtractor` interface.

## Running locally

```bash
bun install
bun run dev          # start the service (web UI + MCP server)
bun run sync         # run sync daemon
bun run build        # compile native binary
```

## Environment variables

```
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=you@gmail.com
IMAP_PASSWORD=app-password-here
SYNC_FROM_DATE=2024-01-01     # default: 1 year ago
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
AUTH_SECRET=...               # signs session cookies
DATA_DIR=/data                # root for maildir, db, vectors
```
