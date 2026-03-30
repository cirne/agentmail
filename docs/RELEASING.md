# Releasing zmail (Rust binary via GitHub Releases)

This document is the **maintainer guide** for shipping a new **Rust/Cargo** version: prebuilt binaries on GitHub Releases and `install.sh` stable installs. It does **not** cover npm publishing.

## Version source of truth

- **[`Cargo.toml`](../Cargo.toml)** field `version` is embedded in the binary as `CARGO_PKG_VERSION` (see [`src/main.rs`](../src/main.rs)); users see it as `zmail --version` / `zmail -V`.

## Invariant

The git tag **must** match the crate version:

- Tag: `vX.Y.Z` (leading `v`, semver).
- **Same commit** must have `version = "X.Y.Z"` in `Cargo.toml` (no `v` prefix there).

If the tag points at an older commit that still has the previous `Cargo.toml` version, the GitHub Release assets will **not** match what `zmail --version` reports.

## What triggers CI

[`.github/workflows/release.yml`](../.github/workflows/release.yml):

- **`push`** of tags matching `v[0-9]*` — builds Linux, macOS ARM, Windows packages, attaches artifacts, and creates/updates a **GitHub Release** (release notes generated for tag pushes).
- **`workflow_dispatch`** — manual test builds with a custom version label; use **Create GitHub Release** only when intentionally testing that path. For real releases, **push a `v*` tag** instead.

Prerelease **nightly** binaries are separate: [`.github/workflows/nightly.yml`](../.github/workflows/nightly.yml). End users install with `install.sh --nightly` (see [`AGENTS.md`](../AGENTS.md)).

## Artifacts and `install.sh`

The workflow sets `RELEASE_VERSION` to the **tag name** (e.g. `v0.2.0`). Archives are named:

`zmail-{RELEASE_VERSION}-{target}.{tar.gz|zip}`

Stable install pins a tag:

```bash
bash install.sh --version v0.2.0
# or: ZMAIL_VERSION=v0.2.0 bash install.sh
```

See [`install.sh`](../install.sh) (`--version` / `pick_stable_asset`).

## Release checklist

Run from the **repository root**:

1. **Quality bar** (same as contributor pre-merge):

   ```bash
   cargo fmt --all -- --check
   cargo clippy --all-targets -- -D warnings
   cargo test
   ```

2. Bump **`Cargo.toml`** `version` to the new semver (e.g. `0.2.0`).

3. **Commit** and **push** the branch (e.g. `main`) so the commit exists on the remote.

4. **Tag** that commit and push the tag:

   ```bash
   git tag -a v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```

   Optional: signed tag with `git tag -s`.

5. **Wait for** the Release workflow to finish on GitHub.

6. **Verify:**
   - Release includes per-triple archives and **`SHA256SUMS`**.
   - `bash install.sh --version v0.2.0` (from a clone or via `curl` raw URL) installs successfully.
   - Installed binary: `zmail --version` shows `0.2.0`.

## Troubleshooting

- **Wrong version in binary:** Tag likely points at a commit before the `Cargo.toml` bump; delete the remote tag only if no one depends on it, fix the commit graph, and re-tag per project policy.
- **Workflow failed:** Fix the cause on `main`, then either move the tag (only if safe) or cut `vX.Y.Z+1` with a new patch/minor bump.

## See also

- [`.github/workflows/release.yml`](../.github/workflows/release.yml) — release builds and GitHub Release upload  
- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — fmt, clippy, tests, release build smoke  
- [`.github/workflows/nightly.yml`](../.github/workflows/nightly.yml) — prerelease/nightly artifacts  
- [`install.sh`](../install.sh) — end-user installer for Release assets  
- [`AGENTS.md`](../AGENTS.md) — install, env, and dev commands  
- [`.cursor/skills/commit/SKILL.md`](../.cursor/skills/commit/SKILL.md) — pre-commit quality checklist  
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — technical context and ADRs  
- [`RUST_PORT.md`](RUST_PORT.md) — parity tracker and packaging notes  
- [`opportunities/OPP-030-rust-port-cutover.md`](opportunities/OPP-030-rust-port-cutover.md) — cutover sequencing  
