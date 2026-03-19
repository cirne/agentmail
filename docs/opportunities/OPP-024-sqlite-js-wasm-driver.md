# OPP-024: SQLite Driver — Optional WASM / JS-Only Path for Installability

**Problem:** zmail depends on `better-sqlite3`, a **native Node addon** (`.node` binary). The module is built for a specific **Node ABI** (`NODE_MODULE_VERSION`). Users hit `ERR_DLOPEN_FAILED` when `node_modules` was installed with a different Node major than the one running the CLI (common with nvm switches, copied trees, or mismatched global install vs runtime). Cloud and minimal images may need a **compiler toolchain** when no prebuilt binary exists for their OS/arch/Node combo.

This is a **distribution and support** friction point, not a query-latency problem: local SQLite work is sub-millisecond class vs **1s+** external LLM and IMAP work, so a somewhat slower driver is unlikely to dominate wall-clock for agent-facing flows.

## Current state

- **Driver:** `better-sqlite3` (`package.json` dependency).
- **Usage pattern:** **Synchronous** API throughout — `db.prepare(…).get() / .all() / .run()`, `db.exec()`, `db.transaction(…)`. Higher-level modules may be `async`, but SQLite I/O blocks the event loop for the duration of each call (standard for this driver).
- **Features in use:** On-disk DB under `ZMAIL_HOME`, **WAL**, pragmas (`journal_mode`, `foreign_keys`, `synchronous`, `busy_timeout`), **FTS5** (`messages_fts`), schema via `PRAGMA user_version`.
- **Docs / UX:** `AGENTS.md` documents “same Node for install and run,” optional `.nvmrc`, Docker guidance; `src/db/index.ts` wraps open failures with a readable hint pointing at that section.

## Why we use `better-sqlite3` today

| Reason | Notes |
|--------|--------|
| **Performance** | Fast, mature, widely used; sync API fits straightforward indexing and search code. |
| **Feature parity** | Full SQLite + FTS5 behavior matches what we expect from desktop/server SQLite. |
| **Ecosystem** | Well-understood operational story for Node tools; good TypeScript typings. |

## Proposed direction (optional future)

Introduce a **portable SQLite backend** based on **WASM or pure JS** (no userland native addon), e.g. **`sql.js`** or **`node-sqlite3-wasm`**, either as a **second implementation behind a thin interface** or as a **replace** if a spike proves parity.

Goals:

- **Installability:** same `npm install` tarball works across Node versions without ABI mismatch for the SQLite layer; fewer “install Python / build-essential” failures when prebuilds are missing.
- **Predictability:** avoid copying `node_modules` between machines with different Node ABIs for the SQLite piece.

Non-goals:

- Winning microsecond benchmarks vs native SQLite (see latency context above).

## What would be involved

1. **Abstraction layer** — Define a small internal API (prepare/step, exec, transaction semantics, close) used by `src/db/` and call sites, with **`better-sqlite3` as implementation A** and WASM as implementation B. Alternatively, confine all access behind existing helpers and swap the concrete type (`SqliteDatabase`).
2. **Persistence model** — `sql.js` defaults to **in-memory**; persisting `zmail.db` means **export/import** on shutdown/interval or a WASM VFS that maps to Node `fs` (e.g. `node-sqlite3-wasm` direction). Must preserve **crash safety** expectations users have with WAL today.
3. **FTS5 and pragmas** — Confirm the chosen build supports **FTS5** and the same SQL we rely on (`messages_fts MATCH`, etc.). Spike: run schema + representative queries from `src/db/schema.test.ts` / search tests.
4. **Sync vs async** — WASM stacks are often **async-friendly**; our code is **sync-heavy**. Options: keep sync by blocking (simplest port, still blocks event loop), or gradually async-ify hot paths (large refactor).
5. **Workers (optional)** — If WASM + large DB hurts UI-ish workloads, consider **worker threads** for DB isolation; high cost, only if measured need.
6. **Tests & CI** — Run full suite on **both** backends or gate WASM to a job matrix row; eval and integration tests unchanged at the product boundary.
7. **Packaging** — `npm` global install and `install-cli` wrapper: document **one** recommended path (native default vs `ZMAIL_SQLITE_BACKEND=wasm` env) if we ship dual backends.

## Tradeoffs

| Aspect | Stay on `better-sqlite3` | WASM / JS-only SQLite |
|--------|--------------------------|------------------------|
| **Install / ABI** | Must match Node used at install vs runtime; prebuild or compile | No `NODE_MODULE_VERSION` mismatch for this dependency |
| **Performance** | Best | Worse CPU/memory; likely still « LLM/IMAP for agent flows |
| **Memory** | mmap / OS page cache friendly | Large DB may mean large WASM heap or careful VFS |
| **Engineering** | Current code | Non-trivial port + ongoing dual-path or cutover risk |
| **Correctness** | Battle-tested path | Requires validation of FTS5, WAL semantics, persistence |

## Impact

- **Code:** Touches `src/db/index.ts`, persistence, search/indexing paths that hold `SqliteDatabase`, tests, possibly MCP/CLI only indirectly.
- **Risk:** Regressions in **FTS**, **locking** (concurrent sync + CLI), or **corruption resistance** if persistence is wrong.
- **Maintenance:** Either **two backends** to test or a **hard cutover** with rollback plan.

## User benefit

- **Fewer failed installs** on mixed Node environments and stricter corporate images where compiling native addons is painful.
- **Clearer mental model:** “any supported Node 20+” without rebuilding SQLite when switching Node versions (for the WASM path).
- **Support load:** Shorter troubleshooting path than explaining ABI errors (still document “same Node for native path” if dual).

## Open questions

- **Single vs dual backend:** Ship WASM only (simpler ops, one code path) vs default native + opt-in WASM (best perf for most, portability for edge cases)?
- **Node built-in `node:sqlite` (22+):** Separate track — avoids npm native addon but **raises minimum Node** and ties to experimental API; does it meet FTS5 + file semantics we need?
- **Spike criteria:** What’s the minimum test list (schema + FTS + concurrent write smoke) before committing?

## Related docs

- `AGENTS.md` — “Node.js and SQLite (no nvm required)”
- `docs/ARCHITECTURE.md` — storage and SQLite decisions (update if we adopt this OPP)
