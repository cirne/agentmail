---
name: install-local
description: Install the Rust zmail binary from a local clone via cargo install-local and optionally link the publishable skill. For npm parity work only, use node/install-npm-legacy.sh or npm run install-cli.
---

# Install zmail from a local clone (dev)

## Preferred: Rust binary (matches releases)

From the **repository root** (or any subdirectory of the clone):

```bash
INSTALL_PREFIX="$HOME/.local/bin" cargo install-local
export PATH="$HOME/.local/bin:$PATH"
```

Copy-only after **`cargo build --release`** (e.g. CI): **`cp target/release/zmail "$INSTALL_PREFIX/zmail"`** and **`chmod 755`**.

After **`cargo install --path .`**, `cargo-install-local` is on `PATH` (usually `~/.cargo/bin`); then **`cargo install-local`** works from any directory (it finds the workspace by walking up from the cwd, or use **`ZMAIL_ROOT`**).

Or test the same path as end users (downloads from GitHub):

```bash
bash install.sh --nightly   # or omit for latest stable Release
```

## Publishable skill (`/zmail`) on Claude Code / OpenClaw

Copy or symlink **`skills/zmail/`** from the repo (not `.cursor/skills/`):

```bash
ln -sf "$(pwd)/skills/zmail" ~/.claude/skills/zmail
# OpenClaw example:
# ln -sf "$(pwd)/skills/zmail" ~/.openclaw/skills/zmail
```

Legacy helper (requires **Node** + **`cd node`**): **`npm run install-skill:claude`** / **`npm run install-skill:openclaw`** — same outcome as a symlink into those dirs.

## Legacy: npm global CLI (parity only)

Only when you need the **Node** reference binary:

```bash
nvm use   # from repo root
cd node && npm run install-cli
```

See **`node/install-npm-legacy.sh`** for **`npm install -g @cirne/zmail`**-style flow without the full **`install-cli`** script.

## Remove

- Rust binary: `rm -f "$(command -v zmail)"` or remove from `INSTALL_PREFIX`.
- npm: `npm uninstall -g @cirne/zmail`

## When to use

- Dogfood **`./target/release/zmail`** against real **`ZMAIL_HOME`**
- Compare behavior to GitHub Release builds
- Optional: verify npm package layout before publish
