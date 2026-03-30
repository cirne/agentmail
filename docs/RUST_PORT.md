# Rust port — tracker

**Canonical ADR:** [ADR-025: Rust Port — Parallel Implementation (Pre-Cutover)](ARCHITECTURE.md#adr-025-rust-port--parallel-implementation-pre-cutover).

**Cutover / packaging:** [OPP-030: Rust Port — Packaging and Cutover](opportunities/OPP-030-rust-port-cutover.md).

**Code:** `rust/` — run `cargo test` from that directory; published CLI remains Node (`@cirne/zmail`) until cutover.

This document is the **single place** for (1) remaining work toward parity and release, (2) **intentional** differences from the Node implementation, and (3) **risks** (ecosystem maturity, behavioral drift). Product opportunities and Node-specific bugs may still reference Rust in passing; link here instead of duplicating long checklists elsewhere.

---

## Remaining items

### Packaging and distribution

- Choose and document the default install path (GitHub releases, Homebrew, npm as thin wrapper, etc.); align version story with `@cirne/zmail`. Tracked in **OPP-030**.

### Production validation

- Run the Rust binary against real `ZMAIL_HOME` + IMAP and compare to Node for **sync**, **refresh**, and JSON/text outputs for **search**, **who**, **read**, **thread**, **status**, **`ask`**, **MCP** — especially edge cases (large mailboxes, provider quirks, date boundaries).
- Integration tests under `rust/tests/` are necessary but not sufficient (ADR-025 checkpoint).

### Feature parity — CLI

The Rust binary currently focuses on core read/sync/index flows. **Not exposed as CLI** (or only stubbed) compared to Node:

| Area | Notes |
|------|--------|
| **`zmail ask`** | **Implemented:** Nano → context assembly → Mini (`gpt-4.1-nano` / `gpt-4.1-mini`), matching Node’s architecture; requires `ZMAIL_OPENAI_API_KEY`. Automated LLM-as-judge parity is still Node (`ask.eval.test.ts`); **`search` `includeThreads`** in the investigation tool is not wired in Rust yet (short-term parity gap). |
| **`zmail inbox`** | Window parsing exists; no full notable-mail scan. |
| **`zmail attachment` `list` / `read`** | Extraction libraries exist; no dedicated CLI subcommands. |
| **`zmail send` / `zmail draft` `*`** | Draft storage helpers exist; **SMTP send** returns an error unless `dry_run` (`send::plan_send`). |
| **`zmail wizard`** | Interactive wizard not implemented; `setup` writes files only. |
| **Setup validation** | IMAP/OpenAI checks after `zmail setup` not implemented in Rust (Node validates unless `--no-validate`). |
| **Flags** | Examples: search **`--ids-only`**, who **`--enrich`**, thread **`--raw`**, status **`--imap`** — not all mirrored on the Rust CLI. |

### Feature parity — MCP (`rust/src/mcp`)

Tool **names** align with the contract, but several handlers are **minimal or stubbed** (e.g. simplified `get_status`, stub strings for some attachment/draft paths). Full behavioral parity with Node MCP is tracked alongside [BUG-025](bugs/BUG-025-mcp-cli-parity-alignment-skill.md) (Node-first) and should be re-checked for Rust before cutover.

### Data / behavior parity

- **`who` nicknames:** Rust uses a **small compile-time subset** of the TypeScript nickname map (`rust/src/search/nicknames.rs`). See [BUG-026](bugs/BUG-026-who-nicknames-i18n-and-query-contract.md) — intentional short-term tradeoff until a shared data artifact or generation step exists.

### Documentation and user-facing install

- After cutover: update `skills/zmail/`, `install.sh`, **AGENTS.md** primary install path, and any publishable docs that still assume npm-only. Until then, Rust is **developer-only** (see [AGENTS.md](../AGENTS.md#rust-port-in-repo)).

### Schema

- Same **no row-level migrations** philosophy as Node ([ADR-021](ARCHITECTURE.md#adr-021-schema-drift-handling--auto-rebuild-from-maildir)); any Rust-only drift must bump **`SCHEMA_VERSION`** and stay aligned with TypeScript.

---

## Intentional differences (and where Rust helps)

These are **acceptable by default** unless we explicitly decide to match Node.

| Topic | Choice |
|-------|--------|
| **SQLite** | **`rusqlite`** with **`bundled`** SQLite — no native Node addon or `NODE_MODULE_VERSION` issues ([ADR-023](ARCHITECTURE.md#adr-023-sqlite-access--file-backed-native--async-facade--abi-recovery) contrast). Single predictable embedded engine version per release. |
| **Distribution** | **One native binary** (per target) — simpler ops than Node + global npm + native addon recovery paths ([OPP-024 archive](opportunities/archive/OPP-024-sqlite-node-abi-mitigation.md) motivation). |
| **IMAP client** | Rust **`imap`** crate (see risks below), not **imapflow** — different API and behavior surface; chosen for native Rust stack integration. |
| **CPU-bound work** | **Rayon** for parallel maildir/parse-style work where appropriate — idiomatic Rust parallelism vs Node `worker_threads` model. |
| **Async model** | Library and CLI use **synchronous** SQLite and blocking IMAP in many paths — simpler than forcing full async end-to-end; differs from Node’s async `SqliteDatabase` facade but matches “blocking is OK” for a CLI tool. |
| **Nickname map** | Smaller embedded map until shared JSON or codegen — reduces duplication cost and binary churn; document divergence (BUG-026). |
| **MCP JSON-RPC** | Minimal `inputSchema` placeholders in some places — acceptable for in-repo dev; tighten before calling MCP “stable” for agents. |

“Better” is not automatic: differences must still pass **real-mailbox validation** and documented agent contracts ([MCP.md](MCP.md), CLI help).

---

## Challenges, limitations, and quality risks

| Risk | Detail |
|------|--------|
| **IMAP crate maturity** | Dependency on **`imap` `3.0.0-alpha.*`** — pre-1.0 API and possible bugfix churn. Behavior vs **imapflow** (Node) may differ on edge cases (IDLE, extensions, error recovery). |
| **TLS** | **`native-tls`** (platform TLS) vs **rustls** — tradeoffs in trust stores, platform behavior, and supply chain; worth revisiting if users hit TLS or cert issues on niche platforms. |
| **Attachment / office stack** | Rust uses **pdf-extract**, **docx-rs**, **calamine**, **htmd**, etc. Parity with Node’s **ExcelJS** / **mailparser** pipeline is **best-effort** — formatting, edge-case files, or malformed documents may diverge. |
| **Provider quirks** | Gmail and others sometimes need workarounds developed against the **Node** client first; Rust sync must be **bakeoff-tested** so divergences are caught early. |
| **Dual implementation** | Until cutover, fixes may land in **one** codebase first — [BUGS.md](BUGS.md) notes that active bugs often refer to the **published Node** CLI; Rust regressions need explicit tracking. |
| **LLM features** | **OpenAI**-backed flows (`ask`, `draft edit`, `inbox`, optional **`who --enrich`**) depend on Node’s TS stack today; reimplementing in Rust implies new HTTP clients, prompt management, and eval coverage — scope as its own milestone, not a side effect of sync/search. |

---

## Related links

| Doc | Role |
|-----|------|
| [ARCHITECTURE.md § ADR-025](ARCHITECTURE.md#adr-025-rust-port--parallel-implementation-pre-cutover) | Decision record (parallel implementation, stack summary). |
| [OPP-030](opportunities/OPP-030-rust-port-cutover.md) | Packaging sequence and cutover. |
| [AGENTS.md](../AGENTS.md#rust-port-in-repo) | How to build and run Rust from the monorepo. |
| [rust/README.md](../rust/README.md) | Short developer pointer into `rust/`. |
