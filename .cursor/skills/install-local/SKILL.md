---
name: install-local
description: Install zmail globally from the local dev directory (npm run install-cli) — build dist/ then npm install -g . Same as testing the published package without the registry.
---

# Install zmail from a local clone (dev)

## Preferred command

From the **repository root**:

```bash
npm run install-cli
```

This runs **`npm run build`** (compile to `dist/`) then **`npm install -g .`**, installing **`@cirne/zmail`** into your npm global prefix so `zmail` on your PATH runs **`dist/index.js`**.

## Requirements

- **Node.js 22.16+** (see `engines` in `package.json`; built-in `node:sqlite`). The repo’s **`.npmrc`** sets **`engine-strict=true`**, so `npm install` / `npm install -g .` **fail** with `EBADENGINE` if Node is too old — not a warning.
- Write access to the global npm prefix (sometimes requires fixing npm permissions or using a Node version manager)

## After install

- Run `zmail` from any directory; config/data default to `~/.zmail` (or `ZMAIL_HOME`).

## Remove

```bash
npm uninstall -g @cirne/zmail
```

## When to use

- Dogfood the **same path as end users** (`bin` → `dist/index.js`) while developing in the repo
- Verify global install and CLI behavior before publish

## Not this

- Day-to-day dev from the repo without touching global install: **`npm run zmail -- <cmd>`** or **`npx tsx src/index.ts -- <cmd>`**
