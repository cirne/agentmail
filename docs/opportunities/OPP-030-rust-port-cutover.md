# OPP-030: Rust Port — Packaging and Cutover

**Status:** Open — Rust is the default install path; remaining work is product triage, confidence, and retirement of the legacy Node surface.

**Problem:** zmail is implemented twice (Rust at repo root, Node under `node/`). **Default install is now** **`install.sh`** → GitHub Release binaries; skills and AGENTS lead with that path. **Remaining:** decide which old Node-only surfaces are actually worth keeping, move confidence checks to Rust, then retire or clearly fence the npm surface.

**Canonical technical context:** [ADR-025](../ARCHITECTURE.md#adr-025-rust-port--parallel-implementation-pre-cutover) — stack, integration test layout (`tests/*.rs` at crate root). **Detailed parity tracker:** [RUST_PORT.md](../RUST_PORT.md).

**Proposed direction (sequencing):**

1. **CI:** `cargo clippy` + `cargo test` at the **repository root** on every PR.
2. **Triage:** classify every remaining Node-era gap as **keep / port**, **redesign**, or **drop**. Do not port legacy flags only because they once existed.
3. **Dogfood:** Run `cargo run --release -- …` or `./target/release/zmail` against real `ZMAIL_HOME`; file only the retained, high-value gaps as bugs or ADR-025 checklist updates.
4. **Packaging:** choose the end-state for npm — thin wrapper/downloader or retirement. Align with [OPP-007 archive](archive/OPP-007-packaging-npm-homebrew.md) lessons (global install reliability).
5. **Cutover:** ~~Update `AGENTS.md`, `skills/zmail/`, `install.sh`~~ — **done** for binary-first docs. Remove Node from the supported path once no retained workflow or confidence check depends on it.

**Non-goals (this opp):** Rewriting product features — parity is tracked in ADR-025 and integration tests.
