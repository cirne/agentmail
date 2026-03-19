---
name: install-cli
description: Install a zmail wrapper script to a directory on PATH so you can run `zmail` from any directory (e.g. other workspaces). The wrapper pins the Node binary from install time and runs local tsx — no compiled binary.
---

# CLI installation (dev time)

## Principle

Installs a small wrapper script at `~/.local/bin/zmail` (or `ZMAIL_INSTALL_DIR`) that runs `<install-node> <repo>/node_modules/tsx/dist/cli.mjs <repo>/src/index.ts -- "$@"`. The install-time Node path is **absolute**, so whichever `node` is first on `PATH` in your shell does not change how zmail runs. You can then run `zmail` from any directory; config is still read from `~/.zmail/`.

## What it does

1. **Writes** a bash script to `~/.local/bin/zmail` (or `ZMAIL_INSTALL_DIR`)
2. The script **exec**s the pinned Node + local tsx CLI (repo path and Node path are embedded at install time)
3. **Creates** the install directory if needed and sets the script executable (755)
4. **Prints** instructions for PATH and reinstall-after-move

## Usage

```bash
npm run install-cli
```

Or directly:
```bash
npx tsx scripts/install-cli.ts
```

## Install location

- **Default:** `~/.local/bin/zmail`
- **Override:** Set `ZMAIL_INSTALL_DIR` environment variable to install elsewhere
  ```bash
  ZMAIL_INSTALL_DIR=/usr/local/bin npm run install-cli
  ```

## PATH setup

After installation, ensure the install directory is on your PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Add this to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.) to make it permanent.

## When to use

- **Testing from another workspace** — Install the wrapper so you can run `zmail` from a different directory
- **After moving the repo** — Run `npm run install-cli` again from the new path to update the embedded repo path
- **After changing Node** — Re-run install-cli so the embedded `node` path matches where you run `npm install` / native addons
- **Cross-project testing** — Use zmail CLI from other Claude Code projects or workspaces

## How it works

The script (`scripts/install-cli.ts`):
1. Resolves the project root (from `import.meta.dirname`)
2. Verifies `node_modules/tsx/dist/cli.mjs` exists (otherwise tells you to `npm install`)
3. Writes a bash script that sets `ZMAIL_REPO` and `NODE_BIN` (`process.execPath`) and runs tsx with that Node

## Notes

- The installed **wrapper** runs the **source** via tsx — it requires Node.js and the repo (or a copy) at the path used when you ran install-cli
- Config and data dir are under **ZMAIL_HOME** (default `~/.zmail`): `config.json`, `.env`, and `data/` (DB, maildir, vectors). Override with the `ZMAIL_HOME` env var only; there is no `DATA_DIR`.
- For a **standalone** install (no repo), use `npm run build` then `npm i -g .` so the `zmail` bin runs `dist/index.js` with Node
