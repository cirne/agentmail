# Rust — parity tracker

**Canonical ADR:** [ADR-025: Rust Port — Parallel Implementation (Pre-Cutover)](ARCHITECTURE.md#adr-025-rust-port--parallel-implementation-pre-cutover).

**Cutover / packaging:** [OPP-030: Rust Port — Packaging and Cutover](opportunities/OPP-030-rust-port-cutover.md).

**Code:** Repository root — run `cargo test` from the workspace root. **Node reference** lives under **`node/`** (published as `@cirne/zmail`).

This document is the **single place** for (1) remaining work toward parity and release, (2) **intentional** differences from the Node implementation, and (3) **risks** (ecosystem maturity, behavioral drift). Product opportunities and Node-specific bugs may still reference Rust in passing; link here instead of duplicating long checklists elsewhere.

---

## Remaining items

### Packaging and distribution

- **How to ship a versioned Rust binary:** [RELEASING.md](RELEASING.md) (tag + `Cargo.toml`, GitHub Releases, `install.sh`).
- Finalize the end-state install story: GitHub Release binaries are the default today; decide whether npm survives only as a thin downloader/wrapper or is retired entirely. Tracked in **OPP-030**.

### Production validation

- Run the Rust binary against real `ZMAIL_HOME` + IMAP and compare to Node for **sync**, **refresh**, and JSON/text outputs for **search**, **who**, **read**, **thread**, **status**, **`ask`**, **`inbox`**, **MCP** — especially edge cases (large mailboxes, provider quirks, date boundaries).
- Integration tests under `tests/` (crate root) are necessary but not sufficient (ADR-025 checkpoint).

### CLI — decisions, not parity-for-parity

- **Keep / port:** `status --imap` is worth keeping because it helps debug sync drift and provider issues against the live mailbox.
- **Redesign / defer:** `who --enrich` should not be ported blindly. Its value is narrower than core local `who`, and it adds LLM/network complexity to a command whose main strength is fast local lookup.
- **Drop unless a concrete workflow appears:** `search --ids-only` and `thread --raw` are low-value output variants that add contract surface more than user value.
- **Drop or explicitly defer:** `zmail send --raw` (RFC 822 from stdin / `--file`) is powerful but not part of the core local-draft workflow; only revive it if a real import/relay use case emerges.
- **`zmail draft`:** **Implemented in Rust** (`zmail draft list|view|new|reply|forward|edit|rewrite`) and remains the preferred compose surface.

### `zmail ask` — investigation tool

- The **`search` tool’s `includeThreads`** parameter should either work or disappear; silent acceptance without behavior is not acceptable at cutover.
- Automated `ask` confidence still leans on Node-era eval coverage (`node/src/ask/ask.eval.test.ts`); Rust needs its own ownership of the acceptance story before `node/` can be removed.

### MCP (`src/mcp`)

- **Keep / port:** `inputSchema` entries should be real structured schemas, not placeholders, if MCP remains a first-class agent surface.
- **Keep / port:** `create_draft` should support the core draft workflow instead of returning stub success.
- **Tracker cleanup:** `delete_draft` is **not** a real Rust-behind-Node parity gap; the Node MCP implementation does not expose equivalent behavior. Decide separately whether Rust should keep or remove the stub tool.
- **Behavioral depth** (e.g. `get_status`) may still differ — re-check against [BUG-025](bugs/BUG-025-mcp-cli-parity-alignment-skill.md) before cutover.

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
| **Nickname map (`who`)** | Rust intentionally ships a smaller embedded map (`src/search/nicknames.rs`) than the old TypeScript reference unless/until we choose a shared data artifact. Do not blindly port the large Node list; see [BUG-026](bugs/BUG-026-who-nicknames-i18n-and-query-contract.md). |
| **Wizard UX** | **inquire** + **indicatif** vs Node line prompts — intentional UX upgrade; flags and config shape match Node. |
| **JSON `messageId` / `threadId`** | Rust CLI and MCP emit **bare** ids (no RFC 5322 `<>`). The Node reference package may still show bracketed strings in JSON until aligned; both stacks accept bracketed or bare on input. |

“Better” is not automatic: differences must still pass **real-mailbox validation** and documented agent contracts ([MCP.md](MCP.md), CLI help).

---

## Challenges, limitations, and quality risks

| Risk | Detail |
|------|--------|
| **IMAP crate maturity** | Dependency on **`imap` `3.0.0-alpha.*`** — pre-1.0 API and possible bugfix churn. Behavior vs **imapflow** (Node) may differ on edge cases (IDLE, extensions, error recovery). |
| **TLS** | **`native-tls`** (platform TLS) vs **rustls** — tradeoffs in trust stores, platform behavior, and supply chain; worth revisiting if users hit TLS or cert issues on niche platforms. |
| **Attachment / office stack** | Rust uses **`pdf_oxide`** for PDF text (`extract_all_text`; tolerates many real-world PDFs; closer to Node’s **pdf.js** path than older pure-Rust extractors). PDF parts are detected from `application/pdf` (including parameterized MIME), or a filename ending in `.pdf` (e.g. mislabeled `application/octet-stream`). **docx-rs** (paragraph text; Node **mammoth** yields Markdown), **calamine** (XLSX/XLS → CSV with quoted fields and multi-sheet `## Sheet:` headers), **htmd** (HTML → Markdown). Unsupported binaries get the same **stub line** as Node (`[Binary attachment: …]`). Parity with Node’s **ExcelJS** / **mailparser** pipeline is still **best-effort** on edge-case or malformed files. |
| **MIME filenames (UTF-8 in quoted strings)** | **Fixed (2026-04-03):** [BUG-036 archived](bugs/archive/BUG-036-pdf-attachments-non-ascii-filename-mime-parse.md) — raw UTF-8 in quoted `filename=` plus MIME-type/index fallback names; regression tests in `tests/attachments_extract.rs`, `tests/sync_parse_maildir.rs`. Other attachment/office edge cases remain best-effort (see **Attachment / office stack** above). |
| **Provider quirks** | Gmail and others sometimes need workarounds developed against the **Node** client first; Rust sync must be **bakeoff-tested** so divergences are caught early. |
| **Dual implementation** | Until cutover, fixes may land in **one** codebase first — [BUGS.md](BUGS.md) notes that active bugs often refer to the **published Node** CLI; Rust regressions need explicit tracking. |
| **LLM and compose** | Draft compose/edit are available in Rust. `who --enrich` is not part of the cutover-critical surface unless we explicitly keep it. |

---

## Related links

| Doc | Role |
|-----|------|
| [ARCHITECTURE.md § ADR-025](ARCHITECTURE.md#adr-025-rust-port--parallel-implementation-pre-cutover) | Decision record (parallel implementation, stack summary). |
| [OPP-030](opportunities/OPP-030-rust-port-cutover.md) | Packaging sequence and cutover. |
| [AGENTS.md](../AGENTS.md) | How to build and run Rust and Node from the monorepo. |
| [README.md](../README.md) | Repo overview; architecture, docs index, and developing from source (Rust). |

## Rust send: deferred edge case

Node **`zmail send --raw`** (RFC 822 from **stdin** or **`--file <path>`**) is **not** implemented in the Rust CLI. Rust supports plain **`--to` / `--subject` / `--body`** (and optional stdin body when piped), **`zmail send <draft-id>`**, and the same optional recipient guard via **`ZMAIL_SEND_TEST`**. For cutover, treat raw-message send as a **deferred / probably dropped** edge case rather than a must-port parity item.
