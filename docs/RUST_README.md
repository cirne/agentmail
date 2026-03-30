# zmail (Rust)

Primary in-repo implementation: IMAP sync, SQLite + FTS5, CLI, MCP stdio, attachments, SMTP/drafts, and LLM-shaped commands. Targets the same **`ZMAIL_HOME`** / **`~/.zmail`** layout as the Node reference under **`node/`**.

**Docs:** [RUST_PORT.md](RUST_PORT.md) (remaining parity vs Node, intentional differences, risks), [ADR-025](ARCHITECTURE.md#adr-025-rust-port--parallel-implementation-pre-cutover) (decision record), [AGENTS.md](../AGENTS.md) (commands and layout), [OPP-030](opportunities/OPP-030-rust-port-cutover.md) (packaging cutover).

**CI:** [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) (fmt, clippy, test, release build on Ubuntu). Releases: [`release.yml`](../.github/workflows/release.yml) (tag `v*`), nightly binaries: [`nightly.yml`](../.github/workflows/nightly.yml) (daily UTC schedule + manual dispatch; builds default branch).

From the **repository root**:

```bash
cargo test
cargo run -- --help
cargo build --release
./target/release/zmail status
# IMAP sync (same ZMAIL_HOME / credentials as Node)
cargo run -- sync --foreground --since 7d
cargo run -- refresh
# Natural-language Q&A (OpenAI; same key as Node `zmail ask`)
cargo run -- ask "summarize invoices from last week" --verbose
```

**Tests:** Unit tests live in `src/` under `#[cfg(test)] mod tests { ... }` next to the code they exercise. Integration tests (one crate per file under `tests/`, e.g. `config_schema_status`, `search_fts`, `mcp_stdio`) exercise the public `zmail` API end-to-end. After changing a module, a fast check is `cargo test --lib <filter>`; run full `cargo test` before merge.

Install helper for a built release binary: `./install-rust-binary.sh` (optional `INSTALL_PREFIX`).

The published **`npm install -g @cirne/zmail`** artifact is still produced from **`node/`** until packaging fully switches (OPP-030).
