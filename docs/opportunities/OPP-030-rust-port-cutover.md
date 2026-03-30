# OPP-030: Rust Port — Packaging and Cutover

**Status:** Open — in-repo implementation landed; distribution not switched.

**Problem:** zmail is implemented twice (Rust at repo root, Node under `node/`). **Default install is now** **`install.sh`** → GitHub Release binaries; skills and AGENTS lead with that path. **Remaining:** retire or clearly fence the npm surface when parity no longer needs publishing; optional Homebrew, etc.

**Canonical technical context:** [ADR-025](../ARCHITECTURE.md#adr-025-rust-port--parallel-implementation-pre-cutover) — stack, integration test layout (`tests/*.rs` at crate root). **Detailed parity tracker:** [RUST_PORT.md](../RUST_PORT.md).

**Proposed direction (sequencing):**

1. **CI:** `cargo clippy` + `cargo test` at the **repository root** on every PR.
2. **Dogfood:** Run `cargo run --release -- …` or `./target/release/zmail` against real `ZMAIL_HOME`; file gaps as bugs or ADR-025 checklist updates.
3. **Packaging:** Choose among — static-friendly binary + GitHub releases; Homebrew formula; npm as downloader/wrapper; etc. Align with [OPP-007 archive](archive/OPP-007-packaging-npm-homebrew.md) lessons (global install reliability).
4. **Cutover:** ~~Update `AGENTS.md`, `skills/zmail/`, `install.sh`~~ — **done** for binary-first docs. Deprecate or retire Node entrypoint per ADR-008 amendment when ready.

**Non-goals (this opp):** Rewriting product features — parity is tracked in ADR-025 and integration tests.
