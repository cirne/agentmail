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

This runs **`npm run build`** (compile to `dist/`), then **`npm install -g .`**, then installs the publishable **`skills/zmail/`** tree into **`~/.claude/skills/zmail`** (symlink to the repo by default) so **Claude Code** can use **`/zmail`** as a global skill. Skip the skill step with **`ZMAIL_SKIP_CLAUDE_SKILL=1`**. Install only the skill: **`npm run install-skill:claude`**.

## Requirements

- **Node.js 20+** (see `engines` in `package.json`). The repo’s **`.npmrc`** sets **`engine-strict=true`**, so `npm install` / `npm install -g .` **fail** with `EBADENGINE` if Node is too old — not a warning.
- Write access to the global npm prefix (sometimes requires fixing npm permissions or using a Node version manager)

## After install

- Run `zmail` from any directory; config/data default to `~/.zmail` (or `ZMAIL_HOME`).
- **`better-sqlite3`** is a native addon; first **`zmail`** run may run **`npm rebuild better-sqlite3`** if the addon’s ABI does not match the running Node (`ensure-better-sqlite-native`).
- **Claude Code:** restart or start a new session so **`/zmail`** loads from **`~/.claude/skills/zmail`**. Copy instead of symlink: **`ZMAIL_CLAUDE_SKILL_MODE=copy`**.

## Remove

```bash
npm uninstall -g @cirne/zmail
```

## When to use

- Dogfood the **same path as end users** (`bin` → `dist/index.js`) while developing in the repo
- Verify global install, native addon, and CLI behavior before publish

## Not this

- Day-to-day dev from the repo without touching global install: **`npm run zmail -- <cmd>`** or **`npx tsx src/index.ts -- <cmd>`**
