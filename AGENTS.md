# zmail — Agent Guide

**zmail** is an agent-first email system. It syncs email from IMAP providers, indexes it locally, and exposes it as a queryable dataset via a CLI and MCP server. Runs on **Node.js 20+**; dev uses `tsx`, distributed via npm as `@cirne/zmail` (see [OPP-007](docs/opportunities/archive/OPP-007-packaging-npm-homebrew.md)). **Outbound mail** uses SMTP send-as-user (`zmail send`, `zmail draft`, MCP tools); optional `ZMAIL_SEND_TEST=1` restricts recipients for dev/test (see [ADR-024](docs/ARCHITECTURE.md#adr-024-outbound-email--smtp-send-as-user--local-drafts)).

**Quick install:**
```bash
npm install -g @cirne/zmail
# Alternative: curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | bash
```

## Key documents

- **End users of zmail (publishable skill `/zmail`):** [`skills/zmail/SKILL.md`](skills/zmail/SKILL.md) — [Agent Skills](https://agentskills.io/specification.md) playbook (`name: zmail`); install, setup, sync, usage; see [`skills/README.md`](skills/README.md). Distinct from internal **`.cursor/skills/*`** below.
- **Developing this repo in Cursor:** `.cursor/skills/` — internal skills (`commit`, `db-dev`, `install-local`, `process-feedback`). Not the publishable user skill in `skills/zmail/`.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — technical decisions and rationale (**read before making storage, sync, or interface decisions**)
- [`docs/MCP.md`](docs/MCP.md) — MCP server interface documentation (**read for agent integration**)
- [`docs/VISION.md`](docs/VISION.md) — product vision
- [`docs/OPPORTUNITIES.md`](docs/OPPORTUNITIES.md) — product improvement ideas

**Single source of truth:** each fact lives in one place. Update the canonical docs or code not copies. DRY.

## Tech stack

Node.js 20+, TypeScript, **file-backed** SQLite via **`better-sqlite3`** (native addon, OS page cache — not a whole-DB-in-RAM WASM/sql.js model), FTS5, imapflow. Application code uses an **async** `SqliteDatabase` facade (`prepare` / `get` / `all` / `run` / `exec` return Promises; see `~/db`). Dev: `tsx`; install: `npm install -g @cirne/zmail` (or build: `npm run build` → `dist/index.js`).

**Native addon ABI:** `better-sqlite3` ships a `.node` binary for Node’s `NODE_MODULE_VERSION`. On first `zmail` run, **`ensure-better-sqlite-native`** loads the addon; if the ABI is wrong, it runs **`npm rebuild better-sqlite3`** from the install directory (same as manual `npm rebuild` with the `node` that runs `zmail`). **`npm install -g` does not apply package `overrides`;** the published tarball ships **`bundledDependencies`** for the Excel stack so global installs get maintainer-resolved versions — see **ADR-023** in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Rust port (in-repo)

A **Rust** implementation lives under **`rust/`** (same CLI/MCP contract and `~/.zmail` goals; see **[ADR-025](docs/ARCHITECTURE.md#adr-025-rust-port--parallel-implementation-pre-cutover)**). It is **not** the published npm package yet — use it from a clone for development and benchmarking.

```bash
cd rust
cargo test                    # integration tests (`tests/*.rs`, e.g. config_schema_status, search_fts, mcp_stdio)
cargo run -- search "foo"     # dev binary; same subcommand style as Node zmail
cargo build --release && ./target/release/zmail status
```

If both **`zmail`** (from `npm install -g @cirne/zmail`) and **`./target/release/zmail`** are on your **`PATH`**, the shell resolves whichever comes first — use an explicit path or alias when comparing behavior. **Remaining packaging and cutover:** [OPP-030](docs/opportunities/OPP-030-rust-port-cutover.md).

## Node.js version (nvm)

**Required for development.** Always use the Node version pinned in [`.nvmrc`](.nvmrc) so it matches **`package.json` → `engines`** and the toolchain behaves consistently.

1. **Before** `npm install`, `npm ci`, `npm run install-cli`, or any install that builds **native** dependencies (`better-sqlite3`), run:
   ```bash
   nvm use
   ```
   If that version isn’t installed: `nvm install` (reads `.nvmrc`), then `nvm use`.
2. **`.npmrc`** sets **`engine-strict=true`** — if your shell is on the wrong Node, **`npm install`** fails with **`EBADENGINE`** (this is intentional).
3. **Same Node for install and runtime** — `better-sqlite3` is built for whatever Node ran `npm install`. Using Node 18 in the shell and Node 20 elsewhere causes **`NODE_MODULE_VERSION`** / dlopen errors.

**Agents and CI:** When running repo commands in a subprocess, activate nvm first (e.g. `source ~/.nvm/nvm.sh && nvm use && npm test`) or use a Node 20+ toolchain that matches `.nvmrc`.

## Project structure

```
src/            Node + TypeScript (published CLI today)
  cli/          entrypoint and subcommands
  inbox/        LLM notable-mail scan (`zmail inbox`)
  sync/         IMAP sync engine
  db/           SQLite schema, queries
  search/       FTS5 full-text search
  ask/          answer engine (zmail ask): agent, tools, eval
  attachments/  document extraction → markdown
  mcp/          MCP server tools
  lib/          shared utilities
rust/           Rust port (pre-cutover); see ADR-025 and rust/README.md
```

## Development rules

- **Node:** follow [Node.js version (nvm)](#nodejs-version-nvm) — `nvm use` from the repo root before installs and when running `npm run zmail`, `npm test`, `npm run install-cli`, etc.
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

**Prerequisite:** `nvm use` (see [Node.js version (nvm)](#nodejs-version-nvm)).

```bash
npm install          # builds better-sqlite3 native addon for current Node (engine-strict: Node must match package.json engines, >=20)
npm run dev          # starts background sync (tsx src/index.ts)
npm run zmail --     # CLI from repo (e.g. npm run zmail -- search "foo"); the -- passes args
npm run sync         # initial sync (or: npm run zmail -- sync --since 7d)
npm run refresh      # refresh: fetch new messages (or: npm run zmail -- refresh)
npm run build        # compile to dist/ (tsc + tsc-alias) for npm global install
npm run install-cli  # build + npm install -g . + Claude Code skill (~/.claude/skills/zmail); skip skill: ZMAIL_SKIP_CLAUDE_SKILL=1
npm run lint         # tsc --noEmit (no ESLint)
npm test             # run test suite (excludes eval tests)
npm run eval         # run eval suite (LLM-based evaluation tests, requires ZMAIL_OPENAI_API_KEY)
```

### CLI Commands

zmail search <query> [--limit n] [--from addr] [--after date] [--before date] [--include-noise] [--text] [--result-format auto|full|slim] [--ids-only]
zmail who [query] [--limit n] [--enrich] [--text]  (omit query for top contacts)
zmail read <message_id> [--raw]
zmail thread <thread_id> [--json] [--raw]
zmail ask "<question>" [--verbose]  # Answer a question about your email (requires ZMAIL_OPENAI_API_KEY); -v logs pipeline progress
zmail inbox [<window>] [--since <window>] [--refresh] [--force] [--include-noise] [--text]  # LLM notable-mail scan; default JSON is scan-only unless --refresh (then sync metrics + scan extras; requires OpenAI key)
zmail status [--json]
zmail stats [--json]
zmail rebuild-index              # Wipe SQLite and reindex from local maildir (dev/test; same as schema bump)
zmail attachment list <message_id> [--text]
zmail attachment read <message_id> <index>|<filename> [--raw] [--no-cache]
zmail send [--to addr --subject s] [--raw] [<draft-id>]   # SMTP; saved draft under data/drafts/ (.md optional); optional ZMAIL_SEND_TEST=1 for dev/test allowlist
zmail draft new|reply|forward|list|view|edit|rewrite [--help]   # Local drafts (data/drafts/); list JSON: slim/full like search (--result-format); bodyPreview when full; edit = LLM instruction, rewrite = replace body
zmail mcp  # Start MCP server (stdio)
```

See [`docs/ASK.md`](docs/ASK.md) for **`zmail ask`** vs primitives and for the **compose loop** (`zmail draft` → **`zmail draft edit`** / **`rewrite`** → **`zmail send <draft-id>`**). Publishable playbook: [`skills/zmail/SKILL.md`](skills/zmail/SKILL.md).

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

**Using `zmail` from another directory (local dev):** With **`nvm use`** active, from the repo run **`npm run install-cli`** once — it builds `dist/`, runs `npm install -g .`, and links **`skills/zmail/`** to **`~/.claude/skills/zmail`** so Claude Code can use **`/zmail`** (override: `ZMAIL_CLAUDE_SKILL_DIR`; copy instead of symlink: `ZMAIL_CLAUDE_SKILL_MODE=copy`; skip the skill step: `ZMAIL_SKIP_CLAUDE_SKILL=1`). The global `zmail` command uses the same `dist/index.js` entry as the published package. Remove with `npm uninstall -g @cirne/zmail`. For quick iteration without touching global install, use `npm run zmail -- <command>` from the repo (still use **`nvm use`** so Node matches `.nvmrc`). To install only the Claude skill from the repo: **`npm run install-skill:claude`**.

### Attachment commands

```bash
zmail attachment list <message_id>       # list attachments for a message (JSON)
zmail attachment read <message_id> <index>|<filename>   # extract as markdown/CSV (stdout); index 1-based or exact filename
zmail attachment read <message_id> <index>|<filename> [--raw] [--no-cache]   # --raw: binary; --no-cache: re-extract
```

Supported formats: PDF, DOCX, XLSX, HTML, CSV, TXT. Extraction happens on first read and is cached in the DB.

**CLI help and onboarding (no env required):** `zmail --help`, `zmail -h`, `zmail help`, and bare `zmail` print a **concise command list** (canonical string: `CLI_USAGE` in `src/lib/onboarding.ts`). Use **`zmail <command> --help`** for flags and examples. When to use **`zmail ask`** versus search/read/thread/who/attachment, the **draft + send** loop, and MCP workflows: [docs/ASK.md](docs/ASK.md), [docs/MCP.md](docs/MCP.md), and the end-user skill ([skills/zmail/references/CANONICAL-DOCS.md](skills/zmail/references/CANONICAL-DOCS.md), [skills/zmail/references/DRAFT-AND-SEND.md](skills/zmail/references/DRAFT-AND-SEND.md)). **Progressive disclosure:** JSON output from commands such as **`search`** may include a **`hint`** field (and truncation metadata); text mode may print similar tips after results—read them before inventing a new approach. If any command fails due to missing config, the CLI prints "No config found. Run 'zmail setup' or 'zmail wizard' first."

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

Search JSON includes attachment info: **full** rows list per-file metadata (`id`, `filename`, `mimeType`, `size`, `extracted`, `index` — same 1-based index as `attachment read`); **slim** rows (large result sets with auto format) include a count plus `attachmentTypes` (MIME subtype strings). Text/table output shows 📎 with counts. For `stored_path` or when not searching first, use `zmail attachment list <message_id>`.

## Configuration

zmail stores configuration in `~/.zmail/` (or `$ZMAIL_HOME` if set):

- `~/.zmail/config.json` — non-secret settings (IMAP host/port/user, sync settings, optional `attachments.cacheExtractedText`, optional `inbox.defaultWindow` for `zmail inbox` when no window is passed — default `24h`)
- `~/.zmail/.env` — secrets (ZMAIL_IMAP_PASSWORD, ZMAIL_OPENAI_API_KEY)

Attachment extracted-text cache is **off by default** (each read re-extracts). To use cached extraction on repeat reads, set `"attachments": { "cacheExtractedText": true }` in config.json.

Run `zmail setup` (with flags/env) or `zmail wizard` (interactive) to create these files:

- **`zmail setup`** — CLI/agent-first. Provide `--email`, `--password`, `--openai-key` or env vars. No prompts.
- **`zmail wizard`** — Interactive. Prompts for email, IMAP password, OpenAI API key, and sync settings.
- Creates `~/.zmail/` if it doesn't exist
- Validates credentials (IMAP connection test, OpenAI API test) unless `--no-validate` is used

Optional environment variables:

- `ZMAIL_HOME` — override config directory (default: `~/.zmail`)
- `ZMAIL_WORKER_CONCURRENCY` — optional. Max **`worker_threads`** for CPU-parallel zmail work (maildir parse during reindex / `zmail rebuild-index` today; same knob for future pools). One Node **process**, several V8 isolates; SQLite stays on the main thread. Non-negative integer; **defaults to 8** when unset (see `DEFAULT_ZMAIL_WORKER_CONCURRENCY` in `src/lib/worker-concurrency.ts`). Under Vitest, defaults to **1** unless this var is set. Parallel rebuild parse loads `dist/db/rebuild-parse-worker.js` — run `npm run build` once if you use `tsx`/source without `dist/`. Legacy alias: `ZMAIL_REBUILD_PARSE_CONCURRENCY` (used only if `ZMAIL_WORKER_CONCURRENCY` is unset).

Required environment variables (for `zmail setup`):

- `ZMAIL_EMAIL` — Email address (e.g., `user@gmail.com`)
- `ZMAIL_IMAP_PASSWORD` — IMAP app password (Gmail app password, not regular password)
- `ZMAIL_OPENAI_API_KEY` (or `OPENAI_API_KEY`) — OpenAI API key (optional, for future features)

**Note:** The correct environment variable names are `ZMAIL_EMAIL` and `ZMAIL_IMAP_PASSWORD`. Do not use `IMAP_USER` or `IMAP_PASSWORD` — these are outdated and not supported.