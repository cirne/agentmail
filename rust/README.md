# zmail (Rust)

In-repo port of zmail: IMAP sync, SQLite + FTS5, CLI, MCP stdio, attachments, SMTP/drafts, and LLM-shaped commands. Targets the same **`ZMAIL_HOME`** / **`~/.zmail`** layout as the Node implementation.

**Docs:** [ADR-025](../docs/ARCHITECTURE.md#adr-025-rust-port--parallel-implementation-pre-cutover) (decisions, remaining work), [AGENTS.md](../AGENTS.md#rust-port-in-repo) (how to run from the monorepo), [OPP-030](../docs/opportunities/OPP-030-rust-port-cutover.md) (packaging cutover).

```bash
cargo test
cargo run -- --help
cargo build --release
```

**Tests:** Unit tests live in `src/` under `#[cfg(test)] mod tests { ... }` next to the code they exercise. Integration tests (one crate per file under `tests/`, e.g. `config_schema_status`, `search_fts`, `mcp_stdio`) exercise the public `zmail` API end-to-end. After changing a module, a fast check is `cargo test --lib <filter>` from this directory; run full `cargo test` before merge.

The published **`npm install -g @cirne/zmail`** artifact is still the Node tree at the repo root until cutover (OPP-030).
