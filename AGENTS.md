# zmail — Agent Guide

**zmail** is an agent-first email system. It syncs email from IMAP providers, indexes it locally, and exposes it as a queryable dataset via a CLI binary and MCP server.

## Key documents

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — technical decisions and rationale (**read before making storage, sync, or interface decisions**)
- [`docs/VISION.md`](docs/VISION.md) — product vision
- [`docs/OPPORTUNITIES.md`](docs/OPPORTUNITIES.md) — product improvement ideas
- [`.env.example`](.env.example) — canonical list of environment variables

**Single source of truth:** each fact lives in one place. Update the canonical docs or code not copies. DRY.

## Tech stack

Bun, TypeScript, Hono, SQLite (`bun:sqlite`), FTS5, LanceDB, imapflow, HTMX. Compiles to a native binary via `bun build --compile`.

## Project structure

```
src/
  cli/          entrypoint and subcommands
  sync/         IMAP sync engine
  db/           SQLite schema, queries
  search/       FTS5 and semantic search
  attachments/  document extraction → markdown
  mcp/          MCP server tools
  web/          Hono web UI (HTMX)
  lib/          shared utilities
```

## Development rules

- Never commit email data, credentials, or `.db` files.
- **No migrations.** Schema is applied on DB creation. For schema changes: run manual `ALTER TABLE` / SQL against the live DB to save a resync. Full reset (`rm -rf data/` + resync) also works. Do not create or maintain migration files.
- When testing search, **use the standard search interface** (`search(db, { query })` from `~/search` or the web route). Do not query the DB directly unless debugging or explicitly asked.

## Commands

```bash
bun install
bun run dev          # web UI + MCP server (port 3000), starts background sync
bun run sync         # sync only (or: bun run src/index.ts sync --since 7d)
bun run build        # compile native binary
bun run lint         # tsc --noEmit (no ESLint)
bun test             # run test suite
```

## Env Varialbles
first check existing environmetnt for required variables, which are:

```
IMAP_USER=you@gmail.com
IMAP_PASSWORD=your-16-char-app-password
OPENAI_API_KEY=sk-...
```

if one or more are not specified you will need to setup a .env file (see .env.example)