# zmail — Agent Guide

**zmail** is an agent-first email system. It syncs email from IMAP providers, indexes it locally, and exposes it as a queryable dataset via a CLI and MCP server. Runs on **Node.js 20+**; dev uses `tsx`, distribution via GitHub Packages `npm i -g @cirne/zmail` (see [OPP-007](docs/opportunities/OPP-007-packaging-npm-homebrew.md)).

**Quick install:**
```bash
curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | bash
```

## Key documents

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — technical decisions and rationale (**read before making storage, sync, or interface decisions**)
- [`docs/MCP.md`](docs/MCP.md) — MCP server interface documentation (**read for agent integration**)
- [`docs/VISION.md`](docs/VISION.md) — product vision
- [`docs/OPPORTUNITIES.md`](docs/OPPORTUNITIES.md) — product improvement ideas

**Single source of truth:** each fact lives in one place. Update the canonical docs or code not copies. DRY.

## Tech stack

Node.js 20+, TypeScript, SQLite (`better-sqlite3`), FTS5, LanceDB, imapflow. Dev: `tsx`; install: `curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | bash` or `npm i -g @cirne/zmail` (from GitHub Packages) or build: `npm run build` → `dist/index.js`.

## Project structure

```
src/
  cli/          entrypoint and subcommands
  sync/         IMAP sync engine
  db/           SQLite schema, queries
  search/       FTS5 and semantic search
  attachments/  document extraction → markdown
  mcp/          MCP server tools
  lib/          shared utilities
```

## Development rules

- Never commit email data, credentials, or `.db` files.
- **No migrations.** Schema is applied on DB creation. For schema changes: run manual `ALTER TABLE` / SQL against the live DB to save a resync. Full reset (`rm -rf ~/.zmail/data/` + resync) also works. Do not create or maintain migration files.
- When testing search, **use the standard search interface** (`search(db, { query })` from `~/search`). Do not query the DB directly unless debugging or explicitly asked.

## Commands

```bash
npm install
npm run dev          # starts background sync (tsx src/index.ts)
npm run zmail --     # CLI from repo (e.g. npm run zmail -- search "foo"); the -- passes args
npm run sync         # initial sync (or: npm run zmail -- sync --since 7d)
npm run refresh      # refresh: fetch new messages (or: npm run zmail -- refresh)
npm run build        # compile to dist/ (tsc + tsc-alias) for npm global install
npm run install-cli  # install wrapper to ~/.local/bin so `zmail` runs source from any cwd
npm run lint         # tsc --noEmit (no ESLint)
npm test             # vitest run
```

### Sync logging and background execution

**Recommended:** Run sync in the background for long-running syncs. Each sync run writes a log file to `{ZMAIL_HOME}/logs/sync-{date}-{time}.log`:

```bash
# Run sync in background
zmail sync --since 1y &

# Check sync status
zmail status

# Inspect the latest log (stdout shows log path)
tail -f ~/.zmail/logs/sync-*.log
```

The CLI prints the log file path to stdout (e.g., `Sync log: ~/.zmail/logs/sync-20250306-143022.log`) so agents can tail/inspect it. Verbose logging goes to the file, not stdout, making background execution clean.

**Using `zmail` from the repo:** `npm run zmail -- <command> [args]` (the `--` is required so args reach the CLI). Or: `npx tsx src/index.ts -- <command> [args]`.

**Using `zmail` from another directory:** Run `npm run install-cli` from the repo once. That installs a wrapper at `~/.local/bin/zmail` (or `ZMAIL_INSTALL_DIR`) that runs `npx tsx <repo>/src/index.ts -- "$@"`. Ensure that dir is on your PATH. Or install globally: `npm i -g .` (requires `npm run build` first).

### Attachment commands

```bash
zmail attachment list <message_id>       # list attachments for a message (JSON)
zmail attachment read <attachment_id>     # extract attachment as markdown/CSV (stdout)
zmail attachment read <attachment_id> --raw  # output raw binary (pipe to file)
```

Supported formats: PDF, DOCX, XLSX, HTML, CSV, TXT. Extraction happens on first read and is cached in the DB.

**CLI help and onboarding (no env required):** `zmail --help`, `zmail -h`, `zmail help` show usage; `zmail setup` runs interactive setup. If any command fails due to missing config, the CLI prints "No config found. Run 'zmail setup' first."

## Agent interfaces: CLI vs MCP

zmail provides two interfaces for agents, both accessing the same SQLite index:

**CLI (command-line):**
- Use for direct subprocess calls from agents
- Fast for one-off queries (no persistent connection overhead)
- Returns structured JSON with `--json` flag
- Best for: one-time searches, status checks, simple workflows

**MCP (Model Context Protocol):**
- Use for persistent tool-based integration
- Run `zmail mcp` to start stdio server
- Better for iterative workflows with multiple tool calls
- Best for: agents with MCP support, complex multi-step queries, tool-based integrations

See [`docs/MCP.md`](docs/MCP.md) for MCP server documentation and tool reference.

## Configuration

zmail stores configuration in `~/.zmail/` (or `$ZMAIL_HOME` if set):

- `~/.zmail/config.json` — non-secret settings (IMAP host/port/user, sync settings)
- `~/.zmail/.env` — secrets (ZMAIL_IMAP_PASSWORD, ZMAIL_OPENAI_API_KEY)

Run `zmail setup` to interactively create these files. The setup command:

- Creates `~/.zmail/` if it doesn't exist
- Prompts for email, IMAP password, OpenAI API key, and sync settings
- Validates credentials (IMAP connection test, OpenAI API test) unless `--no-validate` is used
- On re-run, shows existing values as defaults

Optional environment variables:

- `ZMAIL_HOME` — override config directory (default: `~/.zmail`)

Required environment variables:

- `ZMAIL_IMAP_PASSWORD` — IMAP password
- `ZMAIL_OPENAI_API_KEY` (or `OPENAI_API_KEY`) — OpenAI API key