# Rust — parity tracker

**Canonical ADR:** [ADR-025: Rust Port — Parallel Implementation (Pre-Cutover)](ARCHITECTURE.md#adr-025-rust-port--parallel-implementation-pre-cutover).

**Cutover / packaging:** [OPP-030: Rust Port — Packaging and Cutover](opportunities/OPP-030-rust-port-cutover.md).

**Code:** Repository root — run `cargo test` from the workspace root. **Node reference** lives under **`node/`** (published as `@cirne/zmail`).

This document is the **single place** for (1) remaining work toward parity and release, (2) **intentional** differences from the Node implementation, and (3) **risks** (ecosystem maturity, behavioral drift). Product opportunities and Node-specific bugs may still reference Rust in passing; link here instead of duplicating long checklists elsewhere.

---

## Remaining items

### Packaging and distribution

- **How to ship a versioned Rust binary:** [RELEASING.md](RELEASING.md) (tag + `Cargo.toml`, GitHub Releases, `install.sh`).
- Choose and document the default install path (GitHub releases, Homebrew, npm as thin wrapper, etc.); align version story with `@cirne/zmail`. Tracked in **OPP-030**.

### Production validation

- Run the Rust binary against real `ZMAIL_HOME` + IMAP and compare to Node for **sync**, **refresh**, and JSON/text outputs for **search**, **who**, **read**, **thread**, **status**, **`ask`**, **`inbox`**, **MCP** — especially edge cases (large mailboxes, provider quirks, date boundaries).
- Integration tests under `tests/` (crate root) are necessary but not sufficient (ADR-025 checkpoint).

### CLI — gaps vs Node

- **Flags not yet mirrored:** `search --ids-only`, `who --enrich`, `thread --raw`, `status --imap` (Rust text `status` prints a hint about `--imap`, but the flag is not implemented).
- **`zmail draft`:** **Implemented in Rust** (`zmail draft list|view|new|reply|forward|edit|rewrite`), mirroring the Node CLI. LLM paths (`draft new --instruction`, `draft edit`) use the same OpenAI JSON API as Node (`gpt-4.1-mini`).
- **`zmail send --raw`:** RFC 822 from stdin or `--file` — [not ported](#rust-send-edge-cases-not-yet-ported).

### `zmail ask` — investigation tool

- The **`search` tool’s `includeThreads`** parameter is accepted but **ignored** until Rust thread payloads are wired through the ask pipeline (`src/ask/tools.rs`). Automated LLM-as-judge parity for `ask` remains Node (`node/src/ask/ask.eval.test.ts`).

### MCP (`src/mcp`)

- **`inputSchema`** entries are minimal placeholders (`properties: {}`) vs rich Node schemas — tighten before calling MCP stable for agents.
- **`create_draft` / `delete_draft`** return stub success without full Node behavior.
- **Behavioral depth** (e.g. `get_status` vs Node) may still differ — re-check against [BUG-025](bugs/BUG-025-mcp-cli-parity-alignment-skill.md) before cutover.

### Documentation and user-facing install

- **Done:** `install.sh` installs prebuilt Rust binaries from GitHub Releases; **AGENTS.md** and **`skills/zmail/`** lead with that path. **`@cirne/zmail`** (npm) remains documented as reference-only.

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
| **Nickname map (`who`)** | Smaller embedded map (`src/search/nicknames.rs`) than TypeScript until shared JSON or codegen — [BUG-026](bugs/BUG-026-who-nicknames-i18n-and-query-contract.md). |
| **Wizard UX** | **inquire** + **indicatif** vs Node line prompts — intentional UX upgrade; flags and config shape match Node. |

“Better” is not automatic: differences must still pass **real-mailbox validation** and documented agent contracts ([MCP.md](MCP.md), CLI help).

---

## Challenges, limitations, and quality risks

| Risk | Detail |
|------|--------|
| **IMAP crate maturity** | Dependency on **`imap` `3.0.0-alpha.*`** — pre-1.0 API and possible bugfix churn. Behavior vs **imapflow** (Node) may differ on edge cases (IDLE, extensions, error recovery). |
| **TLS** | **`native-tls`** (platform TLS) vs **rustls** — tradeoffs in trust stores, platform behavior, and supply chain; worth revisiting if users hit TLS or cert issues on niche platforms. |
| **Attachment / office stack** | Rust uses **pdf-extract**, **docx-rs** (paragraph text; Node **mammoth** yields Markdown), **calamine** (XLSX/XLS → CSV with quoted fields and multi-sheet `## Sheet:` headers), **htmd** (HTML → Markdown). Unsupported binaries get the same **stub line** as Node (`[Binary attachment: …]`). Parity with Node’s **ExcelJS** / **mailparser** pipeline is still **best-effort** on edge-case or malformed files. |
| **Provider quirks** | Gmail and others sometimes need workarounds developed against the **Node** client first; Rust sync must be **bakeoff-tested** so divergences are caught early. |
| **Dual implementation** | Until cutover, fixes may land in **one** codebase first — [BUGS.md](BUGS.md) notes that active bugs often refer to the **published Node** CLI; Rust regressions need explicit tracking. |
| **LLM and compose** | **`who --enrich`** remains Node-first. Draft compose/edit are available in Rust. |

---

## Related links

| Doc | Role |
|-----|------|
| [ARCHITECTURE.md § ADR-025](ARCHITECTURE.md#adr-025-rust-port--parallel-implementation-pre-cutover) | Decision record (parallel implementation, stack summary). |
| [OPP-030](opportunities/OPP-030-rust-port-cutover.md) | Packaging sequence and cutover. |
| [AGENTS.md](../AGENTS.md) | How to build and run Rust and Node from the monorepo. |
| [README.md](../README.md) | Repo overview; architecture, docs index, and developing from source (Rust). |

## Rust send: edge cases not yet ported

Node **`zmail send --raw`** (RFC 822 from **stdin** or **`--file <path>`**) is **not** implemented in the Rust CLI yet. Rust supports plain **`--to` / `--subject` / `--body`** (and optional stdin body when piped), **`zmail send <draft-id>`**, and the same optional recipient guard via **`ZMAIL_SEND_TEST`**. For raw-message send, use the Node CLI or add a small wrapper until this is ported.
