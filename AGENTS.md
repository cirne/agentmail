# zmail — Agent Guide

**zmail** is an agent-first email system. It syncs email from IMAP providers, indexes it locally, and exposes it as a queryable dataset via a CLI and MCP server. **Primary implementation:** **Rust** at the repository root (`cargo build`, `cargo test`). **End-user install:** prebuilt **Rust** binaries from **GitHub Releases** via `**install.sh`** (no Node). `**node/**` remains a **TypeScript reference** and optional `**@cirne/zmail`** npm artifact for parity work ([OPP-007](docs/opportunities/archive/OPP-007-packaging-npm-homebrew.md)). **Outbound mail** uses SMTP send-as-user (`zmail send`, `zmail draft`, MCP tools); optional `ZMAIL_SEND_TEST=1` restricts recipients for dev/test (see [ADR-024](docs/ARCHITECTURE.md#adr-024-outbound-email--smtp-send-as-user--local-drafts)).

**Quick install (prebuilt Rust binary — default):**

```bash
curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | bash
# If there is no stable Release yet, the script installs from the nightly prerelease automatically.
# Force nightly: bash -s -- --nightly   or   ZMAIL_CHANNEL=nightly
# Custom prefix (must be on `bash`, not `curl`):  curl -fsSL ... | INSTALL_PREFIX=~/bin bash
```

**Troubleshooting:** If you see `**BASH_SOURCE[0]: unbound variable`**, `raw.githubusercontent.com` is serving a **cached old** `install.sh` (npm-era wrapper). Open [install.sh on GitHub](https://github.com/cirne/zmail/blob/main/install.sh) and confirm the file starts with **“Install prebuilt zmail (Rust)”** — if it does but `curl` still fails, install from the **commit** URL shown on that page (**Raw**), or clone the repo and run `**bash install.sh`** locally.

**From source (dev / contributors):**

```bash
cargo install-local   # build --release + install binary + symlink skills/zmail → ~/.claude/skills/zmail (set INSTALL_PREFIX; skip skill: ZMAIL_SKIP_CLAUDE_SKILL=1; same as npm install-skill:claude)
# Copy-only (e.g. CI artifact already at target/release/zmail): cp target/release/zmail "$INSTALL_PREFIX/zmail" && chmod 755 "$INSTALL_PREFIX/zmail"
# After: cargo install --path .  # puts `zmail` and `cargo-install-local` in ~/.cargo/bin so `cargo install-local` works outside the repo
```

**Legacy npm CLI (reference / parity only):** `npm install -g @cirne/zmail` or `bash node/install-npm-legacy.sh` — requires Node 20+.

## Key documents

- **End users of zmail (publishable skill `/zmail`):** `[skills/zmail/SKILL.md](skills/zmail/SKILL.md)` — [Agent Skills](https://agentskills.io/specification.md) playbook (`name: zmail`); install, setup, sync, usage; see `[skills/README.md](skills/README.md)`. Distinct from internal `**.cursor/skills/*`** below.
- **Developing this repo in Cursor:** `.cursor/skills/` — internal skills (`commit`, `db-dev`, `install-local`, `process-feedback`). Not the publishable user skill in `skills/zmail/`.
- `[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)` — technical decisions and rationale (**read before making storage, sync, or interface decisions**)
- `[docs/RELEASING.md](docs/RELEASING.md)` — **maintainers:** tag and ship Rust binaries (GitHub Releases + `Cargo.toml` version alignment)
- `[docs/MCP.md](docs/MCP.md)` — MCP server interface documentation (**read for agent integration**)
- `[docs/VISION.md](docs/VISION.md)` — product vision
- `[docs/OPPORTUNITIES.md](docs/OPPORTUNITIES.md)` — product improvement ideas

**Single source of truth:** each fact lives in one place. Update the canonical docs or code not copies. DRY.

## Early development: no user base, clean breaks

**All agents should default to this mindset.**

- **zmail is early-stage** and does **not** yet have a meaningful production user base.
- **Do not implement migrations** (no migration files, no versioned upgrade scripts) and **do not add backward-compatibility logic** “for existing installs.”
- **Changing an interface** (CLI flags, JSON shapes, MCP tool contracts, config keys): **update callers and docs to the new shape**; do **not** keep parallel support for the old interface unless a maintainer explicitly asks for a transition period.
- **Changing the SQLite schema:** bump **`SCHEMA_VERSION`** in code (see `src/db/`). On open, drift detection **rebuilds the local index from maildir** — no hand-written `ALTER` path is required for normal development.
- **Intent:** avoid compatibility slop. Assume **fresh data + fresh expectations**; prefer the **simplest** design that matches the current product, not the union of every past variant.

## Tech stack

**Rust (default in this repo):** workspace root — `clap` CLI, `**rusqlite`** with bundled SQLite, `**imap**` crate, FTS5, MCP stdio. **Dev:** `cargo run`, `cargo test`; **release:** `cargo build --release` → `./target/release/zmail`. See **[ADR-025](docs/ARCHITECTURE.md#adr-025-rust-port--parallel-implementation-pre-cutover)** and the root **[README.md](README.md)** (architecture and developing from source).

**Node (reference / npm):** `**node/`** — TypeScript parity and `**@cirne/zmail**` on npm; **not** the default install path. **file-backed** SQLite via `**better-sqlite3`**, FTS5, imapflow. Dev: `tsx` from `node/`; `cd node && npm run build` → `node/dist/index.js`. Global npm install is legacy for parity; prefer `**install.sh**` or `**cargo build --release**`.

**Native addon ABI (Node only):** `better-sqlite3` ships a `.node` binary for Node’s `NODE_MODULE_VERSION`. On first `zmail` run, `**ensure-better-sqlite-native`** loads the addon; if the ABI is wrong, it runs `**npm rebuild better-sqlite3**` from the install directory (same as manual `npm rebuild` with the `node` that runs `zmail`). `**npm install -g` does not apply package `overrides`;** the published tarball ships `**bundledDependencies`** for the Excel stack so global installs get maintainer-resolved versions — see **ADR-023** in `[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)`.

**Parity tracker** (remaining work vs Node, intentional differences, risks): [docs/RUST_PORT.md](docs/RUST_PORT.md). **Packaging and cutover:** [OPP-030](docs/opportunities/OPP-030-rust-port-cutover.md).

```bash
# From repository root (Rust)
cargo test
cargo run -- search "foo"
cargo run -- ask "your question"   # OpenAI ask pipeline (requires ZMAIL_OPENAI_API_KEY in env or ~/.zmail/.env)
cargo run -- sync --foreground --since 7d
cargo run -- refresh
cargo build --release && ./target/release/zmail status
```

If multiple `**zmail**` binaries are on `**PATH**` (e.g. npm global + `~/.local/bin`), the shell resolves whichever comes first — use an explicit path or alias when comparing behavior.

## Node.js version (nvm)

**Required for Node / npm work.** Always use the Node version pinned in `[.nvmrc](.nvmrc)` so it matches `**node/package.json` → `engines`** and the toolchain behaves consistently.

1. **Before** `npm install`, `npm ci`, `npm run install-cli`, or any install that builds **native** dependencies (`better-sqlite3`), run `**nvm use`** from the **repository root** (same `.nvmrc` as CI), then work under `**node/`**:
  ```bash
   nvm use
   cd node && npm ci
  ```
   If that version isn’t installed: `nvm install` (reads `.nvmrc`), then `nvm use`.
2. `**node/.npmrc**` sets `**engine-strict=true**` — if your shell is on the wrong Node, `**npm install**` fails with `**EBADENGINE**` (this is intentional).
3. **Same Node for install and runtime** — `better-sqlite3` is built for whatever Node ran `npm install`. Using Node 18 in the shell and Node 20 elsewhere causes `**NODE_MODULE_VERSION`** / dlopen errors.

**Agents and CI:** When running Node tests in a subprocess, activate nvm first (e.g. `source ~/.nvm/nvm.sh && nvm use && cd node && npm test`) or use a Node 20+ toolchain that matches `.nvmrc`.

## Project structure

```
src/            Rust CLI + library (primary); cargo workspace root
tests/          Rust integration tests (`cargo test`)
Cargo.toml      Rust workspace
node/           Node + TypeScript reference + npm package `@cirne/zmail`
  src/          cli/, inbox/, sync/, db/, search/, ask/, attachments/, mcp/, lib/
  tests/        Vitest suites
  package.json
```

## Development rules

- **Rust:** `cargo fmt`, `cargo clippy`, `cargo test` from the **repository root**.
- **Node:** follow [Node.js version (nvm)](#nodejs-version-nvm) — `nvm use` from the repo root, then `**cd node`** before installs and when running `npm run zmail`, `npm test`, `npm run install-cli`, etc.
- Never commit email data, credentials, or `.db` files.
- **No migrations; no backward-compat layers by default** — see [Early development: no user base, clean breaks](#early-development-no-user-base-clean-breaks). **Schema:** bump `SCHEMA_VERSION`; drift rebuild handles it. Optional local hacks: manual SQL on a dev DB or wipe `~/.zmail/data/` and resync.
- When testing search in **Node**, **use the standard search interface** (`search(db, { query })` from `~/search`). Do not query the DB directly unless debugging or explicitly asked.

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
- Backward compatibility — **omit unless the task explicitly requires it** (early dev default: clean breaks; see [Early development](#early-development-no-user-base-clean-breaks))

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

**Rust (repository root):**

```bash
cargo test
cargo run -- --help
cargo run -- inbox 24h --thorough   # iterate on inbox scan without release build
cargo build --release
./target/release/zmail status
```

**Node (after `nvm use`, from `node/`):**

```bash
cd node
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

zmail search  [--limit n] [--from addr] [--after date] [--before date] [--include-noise] [--json] [--text] [--result-format auto|full|slim]
zmail who [query] [--limit n] [--text]  (omit query for top contacts)
zmail read  [--raw] [--json] [--text]
zmail thread  [--json] [--text]
zmail ask "" [--verbose]  # Answer a question about your email (requires ZMAIL_OPENAI_API_KEY); -v logs pipeline progress
zmail refresh [--since ] [--foreground] [--force] [--text]  # sync local mail; --since backfills; use --foreground when blocking on backfill
zmail inbox [] [--since YYYY-MM-DD] [--thorough] [--text]  # deterministic triage (~/.zmail/rules.json + fallback; no OpenAI); run refresh first when recency matters
zmail archive ... [--undo]  # Message-ID as in search/inbox JSON (bare or <...>); local is_archived; optional IMAP when mailboxManagement enabled; JSON stdout
zmail status [--json] [--imap]
zmail stats [--json]
zmail rebuild-index              # Wipe SQLite and reindex from local maildir (dev/test; same as schema bump)
zmail attachment list  [--text]
zmail attachment read  | [--raw] [--no-cache]
zmail send [--to addr --subject s] []   # SMTP; saved draft under data/drafts/ (.md optional); optional ZMAIL_SEND_TEST=1 for dev/test allowlist
zmail draft new|reply|forward|list|view|edit|rewrite [--help]   # Local drafts (data/drafts/); list JSON: slim/full like search (--result-format); bodyPreview when full; edit = LLM instruction, rewrite = replace body
zmail mcp  # Start MCP server (stdio)

```

**`zmail inbox` — fast vs thorough:** Default is the **fast** path (category filter on candidates, cached decisions when **`rules_fingerprint`** matches). **`--thorough`** is the **slow/complete** path: **all** categories, **recompute** classifications (bypass cache), **include archived** mail in the window, **replay** (ignore prior surfaced dedup). Hidden compatibility flags `--include-all`, `--reclassify`, `--replay` still work and combine with `OR` semantics against the same toggles.

**Inbox JSON (agents):** Rows include **`decisionSource`**, **`matchedRuleIds`**, and optional **`hints`**. **`requiresUserAction`**, **`actionSummary`**, and **`counts.actionRequired`** remain in the schema for compatibility; **v1** deterministic inbox keeps action-required **false** / empty unless extended later. **`zmail archive`** drops mail from the unarchived scan window; it does **not** clear persisted columns on **`inbox_decisions`**. End-user workflow: `[skills/zmail/SKILL.md](skills/zmail/SKILL.md)`.

**Archived mail in the scan:** included when **`--thorough`** or **`--reclassify`** (hidden). **`search` / `read`** always see archived mail.

See `[docs/ASK.md](docs/ASK.md)` for **`zmail ask`** vs primitives and for the **compose loop** (`zmail draft` → **`zmail draft edit`** / **`rewrite`** → **`zmail send <draft-id>`**). Publishable playbook: `[skills/zmail/SKILL.md](skills/zmail/SKILL.md)`.

### Sync logging and background execution

**Recommended:** Run sync in the background for long-running syncs. Each sync run writes a log file to `{ZMAIL_HOME}/logs/sync-{date}-{time}.log`:

```bash
# Run sync in background
zmail refresh --since 1y &

# Check sync status
zmail status

# Inspect the latest log (stdout shows log path)
tail -f ~/.zmail/logs/sync-*.log
```

The CLI prints the log file path to stdout (e.g., `Sync log: ~/.zmail/logs/sync-20250306-143022.log`) so agents can tail/inspect it. Verbose logging goes to the file, not stdout, making background execution clean.

**Using `zmail` from the repo (Rust):** `cargo run -- <command> [args]` from the repository root, or `./target/release/zmail` after `cargo build --release`.

**Using `zmail` from the repo (Node):** `cd node && npm run zmail -- <command> [args]` (the `--` is required so args reach the CLI). Or: `cd node && npx tsx src/index.ts -- <command> [args]`.

**Using `zmail` from another directory (local dev):** With `**nvm use`** active, from the repo run `**cd node && npm run install-cli**` once — it builds `node/dist/`, runs `npm install -g .`, and links `**skills/zmail/**` to `**~/.claude/skills/zmail**` so Claude Code can use `**/zmail**` (override: `ZMAIL_CLAUDE_SKILL_DIR`; copy instead of symlink: `ZMAIL_CLAUDE_SKILL_MODE=copy`; skip the skill step: `ZMAIL_SKIP_CLAUDE_SKILL=1`). The global `zmail` command uses the same `dist/index.js` entry as the published package. Remove with `npm uninstall -g @cirne/zmail`. For quick iteration without touching global install, use `cd node && npm run zmail -- <command>` (still use `**nvm use**` so Node matches `.nvmrc`). To install only the Claude skill from the repo: `**cd node && npm run install-skill:claude**`.

### Attachment commands

```bash
zmail attachment list <message_id>       # list attachments for a message (JSON)
zmail attachment read <message_id> <index>|<filename>   # extract as markdown/CSV (stdout); index 1-based or exact filename
zmail attachment read <message_id> <index>|<filename> [--raw] [--no-cache]   # --raw: binary; --no-cache: re-extract
```

Supported formats: PDF, DOCX, XLSX, HTML, CSV, TXT. Extraction happens on first read and is cached in the DB.

**CLI help and onboarding (no env required, Rust binary):** `zmail --help`, `zmail -h`, and bare `zmail` print a **concise command list** (`src/cli/root_help.txt` + `src/main.rs`). `**zmail --version`** prints the version plus **how to upgrade/reinstall** the prebuilt binary (`install.sh` one-liners, nightly, `INSTALL_PREFIX`); `**zmail -V`** is version only (clap short vs long version). `**zmail help**` is accepted like `-h` where the CLI parses it. Use `**zmail <command> --help**` for flags and examples. The `**node/src/lib/onboarding.ts**` `CLI_USAGE` string is **reference-only** for npm parity during the Rust port and may omit Rust-only details. When to use `**zmail ask`** versus search/read/thread/who/attachment, the **draft + send** loop, and MCP workflows: [docs/ASK.md](docs/ASK.md), [docs/MCP.md](docs/MCP.md), and the end-user skill ([skills/zmail/references/CANONICAL-DOCS.md](skills/zmail/references/CANONICAL-DOCS.md), [skills/zmail/references/DRAFT-AND-SEND.md](skills/zmail/references/DRAFT-AND-SEND.md)). **Progressive disclosure:** JSON output from commands such as `**search`** may include a `**hint**` field (and truncation metadata); text mode may print similar tips after results—read them before inventing a new approach. If any command fails due to missing config, the CLI prints "No config found. Run 'zmail setup' or 'zmail wizard' first."

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
- `**zmail ask "<question>"`** — Higher-level answer engine for natural language queries. Handles orchestration internally (Nano → Context assembler → Mini pipeline). See `[docs/ASK.md](docs/ASK.md)` for when to use `ask` vs primitive tools.
- Best for: one-time searches, status checks, simple workflows, natural language Q&A

**MCP (Model Context Protocol):**

- Use for persistent tool-based integration
- Run `zmail mcp` to start stdio server
- Better for iterative workflows with multiple tool calls
- Best for: agents with MCP support, complex multi-step queries, tool-based integrations

See `[docs/MCP.md](docs/MCP.md)` for MCP server documentation and tool reference. See `[docs/ASK.md](docs/ASK.md)` for using `zmail ask` as a higher-level query interface.

## Search

Search uses FTS5 full-text search for keyword matching.

Search JSON includes attachment info: **full** rows list per-file metadata (`id`, `filename`, `mimeType`, `size`, `extracted`, `index` — same 1-based index as `attachment read`); **slim** rows (large result sets with auto format) include a count plus `attachmentTypes` (MIME subtype strings). Text/table output shows 📎 with counts. For `stored_path` or when not searching first, use `zmail attachment list <message_id>`.

## Configuration

zmail stores configuration in `~/.zmail/` (or `$ZMAIL_HOME` if set):

- `~/.zmail/config.json` — non-secret settings (IMAP host/port/user, sync settings, optional `attachments.cacheExtractedText`, optional `inbox.defaultWindow` for `zmail inbox` when no window is passed — default `24h`)
- `~/.zmail/.env` — secrets (ZMAIL_IMAP_PASSWORD, ZMAIL_OPENAI_API_KEY)

Attachment extracted-text cache is **off by default** (each read re-extracts). To use cached extraction on repeat reads, set `"attachments": { "cacheExtractedText": true }` in config.json.

Run `zmail setup` (with flags/env) or `zmail wizard` (interactive) to create these files:

- `**zmail setup`** — CLI/agent-first. Provide `--email`, `--password`, `--openai-key` or env vars. No prompts.
- `**zmail wizard**` — Interactive. Prompts for email, IMAP password, OpenAI API key, and sync settings.
- Creates `~/.zmail/` if it doesn't exist
- Validates credentials (IMAP connection test, OpenAI API test) unless `--no-validate` is used

Optional environment variables:

- `ZMAIL_HOME` — override config directory (default: `~/.zmail`)
- `ZMAIL_WORKER_CONCURRENCY` — optional. Max `**worker_threads**` for CPU-parallel zmail work (maildir parse during reindex / `zmail rebuild-index` today; same knob for future pools). One Node **process**, several V8 isolates; SQLite stays on the main thread. Non-negative integer; **defaults to 8** when unset (see `DEFAULT_ZMAIL_WORKER_CONCURRENCY` in `node/src/lib/worker-concurrency.ts`). Under Vitest, defaults to **1** unless this var is set. Parallel rebuild parse loads `node/dist/db/rebuild-parse-worker.js` — run `cd node && npm run build` once if you use `tsx`/source without `dist/`. Legacy alias: `ZMAIL_REBUILD_PARSE_CONCURRENCY` (used only if `ZMAIL_WORKER_CONCURRENCY` is unset).

Required environment variables (for `zmail setup`):

- `ZMAIL_EMAIL` — Email address (e.g., `user@gmail.com`)
- `ZMAIL_IMAP_PASSWORD` — IMAP app password (Gmail app password, not regular password)
- `ZMAIL_OPENAI_API_KEY` (or `OPENAI_API_KEY`) — OpenAI API key (optional, for future features)

**Note:** The correct environment variable names are `ZMAIL_EMAIL` and `ZMAIL_IMAP_PASSWORD`. Do not use `IMAP_USER` or `IMAP_PASSWORD` — these are outdated and not supported.