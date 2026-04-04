# zmail

Email as a queryable dataset for AI agents.

Modern email systems are human-first — designed around inbox browsing and manual workflows. **zmail** reimagines email as a structured, searchable dataset with a native interface for AI agents.

## What it does

- Syncs email from IMAP (Gmail-first) into local storage (`~/.zmail/data/maildir`, SQLite index at `~/.zmail/data/zmail.db`)
- Indexes for **FTS5** full-text search and exposes CLI + MCP interfaces
- Supports agent-optimized shortlist → hydrate workflows via CLI search controls

## Quick start

1. **Install** (see [AGENTS.md](AGENTS.md) for options)

   **Prebuilt Rust binary (recommended):**
   ```bash
   curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | bash
   ```

   **From source** (repository root):
   ```bash
   cargo install-local   # build release + install; set INSTALL_PREFIX (see AGENTS.md)
   ```

   **Node reference** (`node/` — parity tests, eval harness, legacy npm package):
   ```bash
   cd node && npm install
   ```

2. **Run interactive setup**
   ```bash
   zmail setup
   ```
   Or from the repo via Node:
   ```bash
   cd node && npm run zmail -- setup
   ```
   This creates `~/.zmail/config.json` and `~/.zmail/.env` with your IMAP credentials and OpenAI API key. The setup command validates credentials and guides you through the process.

3. **Bring the local index up to date**
   ```bash
   zmail refresh --since 7d --foreground
   ```
   Or from the repo (Node):
   ```bash
   cd node && npm run zmail -- sync --since 7d --foreground
   ```
   
   **LLM triage over the local index** (run `zmail refresh` first when you need the latest mail):
   ```bash
   zmail inbox
   ```
   Or from the repo (Node):
   ```bash
   cd node && npm run zmail -- inbox
   ```

4. **Search (header-first default)**
   ```bash
   zmail search "apple receipt after:30d" --json
   ```
   Or from the repo (Node):
   ```bash
   cd node && npm run zmail -- search "apple receipt after:30d" --json
   ```

## CLI

```bash
zmail refresh [--since <spec>] [--foreground] [--force] [--text]
zmail search <query> [--limit <n>] [--from <addr>] [--after <date>] [--before <date>]
                  [--include-noise] [--result-format auto|full|slim] [--timings]
                  [--json|--text]
zmail inbox [<window>] [--since YYYY-MM-DD] [--thorough] [--text]
zmail archive <id>... [--undo]
zmail status [--json] [--imap]
zmail stats
zmail read <id> [--raw]         # or zmail message <id>
zmail thread <id> [--json|--text]
zmail mcp                        # Start MCP server (stdio)
```

Query can use inline operators: `from:`, `to:`, `subject:`, `after:`, `before:` (e.g. `zmail search "from:alice@example.com invoice OR receipt"`).

### Agent interfaces

- **CLI**: Use for direct subprocess calls. Fast for one-off queries. Commands default to JSON (search, who, attachment list) or text (read, thread, status, stats). Use `--text` or `--json` flags to override.
- **MCP**: Use for persistent tool-based integration. Run `zmail mcp` to start stdio server. See [`docs/MCP.md`](docs/MCP.md) for details.

### Recommended agent retrieval pattern

```bash
# 1) Fast shortlist
zmail search "from:no_reply@email.apple.com receipt after:30d" \
  --limit 10 --result-format slim --json

# 2) Hydrate selected IDs
zmail read "<message-id>"

# Optional: fetch original raw MIME source
zmail read "<message-id>" --raw
```

### Schema drift recovery

zmail intentionally does not run automatic migrations on existing local DBs. If startup reports schema drift, rebuild local data and resync:

```bash
rm -rf ~/.zmail/data/
zmail refresh --since 7d --foreground
```

For a **maildir-only** SQLite reindex without deleting raw email (same steps as a schema bump), use `zmail rebuild-index` — see [AGENTS.md](AGENTS.md).

## Architecture

**Primary implementation:** Rust at the workspace root — IMAP sync, SQLite + FTS5, CLI, MCP (stdio), attachments, SMTP/drafts, and LLM-shaped commands (`zmail ask`, `zmail inbox`). Uses the same **`ZMAIL_HOME`** / **`~/.zmail`** layout as the TypeScript reference under **`node/`**. **Reference / npm:** Node.js 20+ under **`node/`** (published as `@cirne/zmail`). All data stays on your machine — no cloud sync service, no third-party access to your email.

**Documentation:**
- [`AGENTS.md`](AGENTS.md) — installation, commands, and development
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — technical decisions and rationale ([ADR-025](docs/ARCHITECTURE.md#adr-025-rust-port--parallel-implementation-pre-cutover): Rust port)
- [`docs/RUST_PORT.md`](docs/RUST_PORT.md) — remaining parity vs Node, intentional differences, risks
- [`docs/opportunities/OPP-030-rust-port-cutover.md`](docs/opportunities/OPP-030-rust-port-cutover.md) — packaging and cutover
- [`docs/VISION.md`](docs/VISION.md) — product vision

**CI and releases:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) (fmt, clippy, test, release build on Ubuntu); [`.github/workflows/release.yml`](.github/workflows/release.yml) (push tag `v*` for a GitHub Release; manual dispatch for test builds); [`.github/workflows/nightly.yml`](.github/workflows/nightly.yml) (daily UTC + manual dispatch). **Cutting a versioned Rust release:** [`docs/RELEASING.md`](docs/RELEASING.md).

### Developing from source (Rust)

From the repository root:

```bash
cargo test
cargo run -- --help
cargo build --release
./target/release/zmail status
# IMAP sync (same ZMAIL_HOME / credentials as Node)
cargo run -- refresh --foreground --since 7d
cargo run -- inbox
# Natural-language Q&A (OpenAI; same key as `zmail ask` via Node)
cargo run -- ask "summarize invoices from last week" --verbose
```

Unit tests live in `src/` under `#[cfg(test)] mod tests { ... }` next to the code they exercise. Integration tests are one crate per file under `tests/` (e.g. `search_fts`, `mcp_stdio`) and exercise the public CLI end-to-end. After changing a module, a fast check is `cargo test --lib <filter>`; run full `cargo test` before merging.

**`cargo test` and CPU cores:** By default, Cargo uses one parallel `rustc` job per logical CPU for builds (`cargo test` included). The Rust test harness also runs tests in parallel across logical CPUs when `RUST_TEST_THREADS` is unset. This is documented in [`.cargo/config.toml`](.cargo/config.toml) (we do not cap jobs). To force serial tests (e.g. clearer logs), run `RUST_TEST_THREADS=1 cargo test`.

**Install:** prebuilt binary via `install.sh` (above) or `cargo build --release`; local prefix install with `cargo install-local` (see [`AGENTS.md`](AGENTS.md)). Copy-only after a build: `cp target/release/zmail "$INSTALL_PREFIX/zmail" && chmod 755 "$INSTALL_PREFIX/zmail"`. The `@cirne/zmail` npm package under `node/` remains for parity and legacy use ([OPP-030](docs/opportunities/OPP-030-rust-port-cutover.md)).

## Status

Active development. Core sync/index/search flows are working; CLI search interface is being expanded for agent-first workflows.

## License

MIT
