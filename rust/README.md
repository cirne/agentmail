# zmail (Rust)

In-repo port of zmail: IMAP sync, SQLite + FTS5, CLI, MCP stdio, attachments, SMTP/drafts, and LLM-shaped commands. Targets the same **`ZMAIL_HOME`** / **`~/.zmail`** layout as the Node implementation.

**Docs:** [RUST_PORT.md](../docs/RUST_PORT.md) (remaining parity, intentional differences, risks), [ADR-025](../docs/ARCHITECTURE.md#adr-025-rust-port--parallel-implementation-pre-cutover) (decision record), [AGENTS.md](../AGENTS.md#rust-port-in-repo) (how to run from the monorepo), [OPP-030](../docs/opportunities/OPP-030-rust-port-cutover.md) (packaging cutover).

**CI:** [`.github/workflows/rust-ci.yml`](../.github/workflows/rust-ci.yml) (fmt, clippy, test, release build on Ubuntu). Releases: `rust-release.yml` (tag `v*`), nightly binaries: `rust-nightly.yml` (branch `main`).

```bash
cargo test
cargo run -- --help
cargo build --release
# IMAP sync (same `ZMAIL_HOME` / credentials as Node)
cargo run -- sync --foreground --since 7d
cargo run -- refresh
```

**Tests:** Unit tests live in `src/` under `#[cfg(test)] mod tests { ... }` next to the code they exercise. Integration tests (one crate per file under `tests/`, e.g. `config_schema_status`, `search_fts`, `mcp_stdio`) exercise the public `zmail` API end-to-end. After changing a module, a fast check is `cargo test --lib <filter>` from this directory; run full `cargo test` before merge.

The published **`npm install -g @cirne/zmail`** artifact is still the Node tree at the repo root until cutover (OPP-030).
