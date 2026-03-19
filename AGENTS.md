# zmail — Agent Guide

**zmail** is an agent-first email system. It syncs email from IMAP providers, indexes it locally, and exposes it as a queryable dataset via a CLI and MCP server. Runs on **Node.js 20+**; dev uses `tsx`, distributed via npm as `@cirne/zmail` (see [OPP-007](docs/opportunities/archive/OPP-007-packaging-npm-homebrew.md)). Read-only today; send is in the vision ([VISION.md](docs/VISION.md)) but blocked on customer validation for core search/index/onboarding — we want to nail that first.

**Quick install:**
```bash
npm install -g @cirne/zmail
```

## Key documents

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — technical decisions and rationale (**read before making storage, sync, or interface decisions**)
- [`docs/MCP.md`](docs/MCP.md) — MCP server interface documentation (**read for agent integration**)
- [`docs/VISION.md`](docs/VISION.md) — product vision
- [`docs/OPPORTUNITIES.md`](docs/OPPORTUNITIES.md) — product improvement ideas

**Single source of truth:** each fact lives in one place. Update the canonical docs or code not copies. DRY.

## Tech stack

Node.js 20+, TypeScript, SQLite (`better-sqlite3`), FTS5, imapflow. Dev: `tsx`; install: `npm install -g @cirne/zmail` (or build: `npm run build` → `dist/index.js`).

### Node.js and SQLite (no nvm required)

- **`better-sqlite3` is a native addon:** it must be installed or rebuilt with the **same Node binary** you use to run zmail. That is true on laptops, CI, and cloud images—**nvm is not required** (the optional `.nvmrc` is only a hint for contributors who use nvm: `nvm use` before `npm install`).
- **`npm run install-cli`** writes a wrapper that runs the repo with **the same `node` binary that executed the installer** (absolute path embedded in the script) and local `tsx` (`node_modules/tsx/dist/cli.mjs`), so native addons (e.g. `better-sqlite3`) match the runtime and **your shell’s default `node` on `PATH` does not affect the wrapper**. Re-run install-cli after upgrading Node, changing version managers, or moving the repo.
- **Docker / minimal OS images:** use an [official Node image](https://hub.docker.com/_/node) (or your platform’s supported Node package). Run `npm install` / `npm ci` **in that same image** as production/runtime so the native module matches. If `better-sqlite3` has no prebuild for your OS/arch/Node combo, the install step needs a **build toolchain** (e.g. Debian/Ubuntu: `build-essential`, `python3`; Alpine is trickier—prefer the default `node:*-bookworm` variants over musl unless you know you need Alpine). If you see `ERR_DLOPEN_FAILED` / NODE_MODULE_VERSION, reinstall or `npm rebuild better-sqlite3` **on the machine (or image) that runs Node**, not a copy of `node_modules` from elsewhere.

## Project structure

```
src/
  cli/          entrypoint and subcommands
  sync/         IMAP sync engine
  db/           SQLite schema, queries
  search/       FTS5 full-text search
  ask/          answer engine (zmail ask): agent, tools, eval
  attachments/  document extraction → markdown
  mcp/          MCP server tools
  lib/          shared utilities
```

## Development rules

- Never commit email data, credentials, or `.db` files.
- **No migrations.** Schema is applied on DB creation. For schema changes: run manual `ALTER TABLE` / SQL against the live DB to save a resync. Full reset (`rm -rf ~/.zmail/data/` + resync) also works. Do not create or maintain migration files.
- When testing search, **use the standard search interface** (`search(db, { query })` from `~/search`). Do not query the DB directly unless debugging or explicitly asked.

## Planning and test coverage

**When creating a plan (plan mode), you must articulate the test coverage strategy.** No plan is complete without specifying:

- **What tests must be created** — new test files or test cases needed
- **What tests must be changed** — existing tests that need updates due to behavior changes
- **What tests must be passing** — acceptance criteria: which existing and new tests must pass to consider the work done

The test strategy should cover:
- Unit tests for new/changed functions/modules
- Integration tests for CLI commands or MCP tools
- Eval tests (LLM-based) for `zmail ask` functionality when applicable
- Edge cases and error handling
- Backward compatibility (if applicable)

A plan without a clear test coverage strategy is incomplete and should not be considered ready for implementation.

## Processing ztest feedback

The sibling project `../ztest` hosts Claude Code config for manual testing. When agents discover issues, they write feedback files to `../ztest/feedback/`. Process this feedback using the **process-feedback** skill:

1. **Read feedback files** from `../ztest/feedback/*.md`
2. **Check for duplicates** — search existing bugs (`docs/bugs/`) and opportunities (`docs/opportunities/`)
3. **Check if fixed** — if feedback matches archived/fixed items, delete the feedback file
4. **Convert to bugs/opportunities** — create new bug (`docs/bugs/BUG-XXX-*.md`) or opportunity (`docs/opportunities/OPP-XXX-*.md`) files
5. **Update indexes** — add entries to `docs/BUGS.md` or `docs/OPPORTUNITIES.md`

See `.cursor/skills/process-feedback/SKILL.md` for the complete workflow. The `docs/bugs/` and `docs/opportunities/` directories serve as our issue tracker (Jira replacement).

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
npm test             # run test suite (excludes eval tests)
npm run eval         # run eval suite (LLM-based evaluation tests, requires ZMAIL_OPENAI_API_KEY)
```

### CLI Commands

zmail search <query> [--limit n] [--from addr] [--after date] [--before date] [--include-noise] [--text]
zmail who <query> [--limit n] [--enrich] [--text]
zmail read <message_id> [--raw]
zmail thread <thread_id> [--json] [--raw]
zmail ask "<question>" [--verbose]  # Answer a question about your email (requires ZMAIL_OPENAI_API_KEY); -v logs pipeline progress
zmail status [--json]
zmail stats [--json]
zmail attachment list <message_id> [--text]
zmail attachment read <message_id> <index>|<filename> [--raw] [--no-cache]
zmail mcp  # Start MCP server (stdio)
```

See [`docs/ASK.md`](docs/ASK.md) for details on using `zmail ask` as a higher-level query interface.

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

**Using `zmail` from another directory:** Run `npm run install-cli` from the repo once. That installs a wrapper at `~/.local/bin/zmail` (or `ZMAIL_INSTALL_DIR`) that runs `<install-node> <repo>/node_modules/tsx/dist/cli.mjs <repo>/src/index.ts -- "$@"`. Ensure that dir is on your PATH. Or install globally: `npm i -g .` (requires `npm run build` first).

### Attachment commands

```bash
zmail attachment list <message_id>       # list attachments for a message (JSON)
zmail attachment read <message_id> <index>|<filename>   # extract as markdown/CSV (stdout); index 1-based or exact filename
zmail attachment read <message_id> <index>|<filename> [--raw] [--no-cache]   # --raw: binary; --no-cache: re-extract
```

Supported formats: PDF, DOCX, XLSX, HTML, CSV, TXT. Extraction happens on first read and is cached in the DB.

**CLI help and onboarding (no env required):** `zmail --help`, `zmail -h`, `zmail help` show usage. If any command fails due to missing config, the CLI prints "No config found. Run 'zmail setup' or 'zmail wizard' first."

**Setup (CLI/agent-first):** Provide credentials via flags or env vars. For interactive prompts, use `zmail wizard`.

**Required credentials:**
1. Email address (e.g., `user@gmail.com`) — provided via `--email` flag or `ZMAIL_EMAIL` environment variable
2. IMAP app password (Gmail app password) — provided via `--password` flag or `ZMAIL_IMAP_PASSWORD` environment variable
3. OpenAI API key (optional, for future features) — provided via `--openai-key` flag or `ZMAIL_OPENAI_API_KEY` (or `OPENAI_API_KEY`) environment variable

```bash
zmail setup --email user@gmail.com --password "app-password" --openai-key "sk-..." [--no-validate]
# Or via environment variables:
ZMAIL_EMAIL=user@gmail.com ZMAIL_IMAP_PASSWORD="app-password" ZMAIL_OPENAI_API_KEY="sk-..." zmail setup
```

## Agent interfaces: CLI vs MCP

zmail provides two interfaces for agents, both accessing the same SQLite index:

**CLI (command-line):**
- Use for direct subprocess calls from agents
- Fast for one-off queries (no persistent connection overhead)
- Commands default to JSON (search, who, attachment list) or text (read, thread, status, stats). Use `--text` or `--json` flags to override.
- **`zmail ask "<question>"`** — Higher-level answer engine for natural language queries. Handles orchestration internally (Nano → Context assembler → Mini pipeline). See [`docs/ASK.md`](docs/ASK.md) for when to use `ask` vs primitive tools.
- Best for: one-time searches, status checks, simple workflows, natural language Q&A

**MCP (Model Context Protocol):**
- Use for persistent tool-based integration
- Run `zmail mcp` to start stdio server
- Better for iterative workflows with multiple tool calls
- Best for: agents with MCP support, complex multi-step queries, tool-based integrations

See [`docs/MCP.md`](docs/MCP.md) for MCP server documentation and tool reference. See [`docs/ASK.md`](docs/ASK.md) for using `zmail ask` as a higher-level query interface.

## Search

Search uses FTS5 full-text search for keyword matching.

Search results include attachment metadata (count and file types) in JSON output, and visual indicators (📎) in formatted table output. For document-related queries (contract, invoice, receipt, etc.), hints suggest checking attachments with `zmail attachment list <message_id>`.

## Configuration

zmail stores configuration in `~/.zmail/` (or `$ZMAIL_HOME` if set):

- `~/.zmail/config.json` — non-secret settings (IMAP host/port/user, sync settings, optional `attachments.cacheExtractedText`)
- `~/.zmail/.env` — secrets (ZMAIL_IMAP_PASSWORD, ZMAIL_OPENAI_API_KEY)

Attachment extracted-text cache is **off by default** (each read re-extracts). To use cached extraction on repeat reads, set `"attachments": { "cacheExtractedText": true }` in config.json.

Run `zmail setup` (with flags/env) or `zmail wizard` (interactive) to create these files:

- **`zmail setup`** — CLI/agent-first. Provide `--email`, `--password`, `--openai-key` or env vars. No prompts.
- **`zmail wizard`** — Interactive. Prompts for email, IMAP password, OpenAI API key, and sync settings.
- Creates `~/.zmail/` if it doesn't exist
- Validates credentials (IMAP connection test, OpenAI API test) unless `--no-validate` is used

Optional environment variables:

- `ZMAIL_HOME` — override config directory (default: `~/.zmail`)

Required environment variables (for `zmail setup`):

- `ZMAIL_EMAIL` — Email address (e.g., `user@gmail.com`)
- `ZMAIL_IMAP_PASSWORD` — IMAP app password (Gmail app password, not regular password)
- `ZMAIL_OPENAI_API_KEY` (or `OPENAI_API_KEY`) — OpenAI API key (optional, for future features)

**Note:** The correct environment variable names are `ZMAIL_EMAIL` and `ZMAIL_IMAP_PASSWORD`. Do not use `IMAP_USER` or `IMAP_PASSWORD` — these are outdated and not supported.