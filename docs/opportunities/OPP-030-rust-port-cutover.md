# OPP-030: Rust Port — Packaging and Cutover

**Status:** Open — in-repo implementation landed; distribution not switched.

**Problem:** zmail is implemented twice (Node at repo root, Rust under `rust/`). End users and skills still document `npm install -g @cirne/zmail`. We need a clear path to a single supported binary (or an explicit dual-publish story) without stranding existing installs.

**Canonical technical context:** [ADR-025](../ARCHITECTURE.md#adr-025-rust-port--parallel-implementation-pre-cutover) — stack, integration test layout (`rust/tests/*.rs`). **Detailed parity tracker:** [RUST_PORT.md](../RUST_PORT.md).

**Proposed direction (sequencing):**

1. **CI:** `cargo clippy` + `cargo test` in `rust/` on every PR.
2. **Dogfood:** Run `cargo run --release -- …` or `./target/release/zmail` against real `ZMAIL_HOME`; file gaps as bugs or ADR-025 checklist updates.
3. **Packaging:** Choose among — static-friendly binary + GitHub releases; Homebrew formula; npm as downloader/wrapper; etc. Align with [OPP-007 archive](archive/OPP-007-packaging-npm-homebrew.md) lessons (global install reliability).
4. **Cutover:** Update `AGENTS.md`, `skills/zmail/`, `install.sh`, and publishable docs when Rust becomes the default install path; deprecate or retire Node entrypoint per ADR-008 amendment.

**Non-goals (this opp):** Rewriting product features — parity is tracked in ADR-025 and integration tests.
