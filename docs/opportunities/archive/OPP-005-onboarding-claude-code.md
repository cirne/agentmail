# OPP-005: Onboarding Workflow — Amazing First Run in Claude Code and OpenClaw

**Status: Implemented (archived).** Help/setup without env, canonical onboarding text, auto-onboarding on missing config, `zmail setup`, and install path (install script `curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | bash`, `npm run install-cli` from a clone for global dev install) are in place. llms.txt and stable release URL delivered via [OPP-007](archive/OPP-007-packaging-npm-homebrew.md).

**Problem:** New users in AI-assisted coding environments (Claude Code, OpenClaw, Cursor, etc.) need to get the zmail CLI and configure their account with minimal friction. Gaps that remain: no stable binary URL for "download zmail," and no llms.txt/skill optimized for LLM consumption. The result can be brittle onboarding and repeated back-and-forth ("create an app password," "where do I put it?").

**Example:** A user in Claude Code says "set up zmail for my Gmail." The agent should be able to (1) install the CLI (e.g. `npm i -g zmail`), (2) guide creation of config via `zmail setup` or `.env` in `~/.zmail`, (3) run first sync and confirm success — without cloning the repo or asking the user to hunt for docs.

**Vision:** Onboarding feels **amazing** in Claude Code and OpenClaw: one skill or one doc gives the agent everything. First release is **CLI only**; MCP and web UI onboarding can follow later.

---

## Implemented (current behavior)

- **Help and setup without env** — `zmail --help`, `zmail -h`, `zmail help`, and `zmail setup` run before config is loaded, so they work with no `.env`. An agent can invoke `zmail` or `zmail setup` to discover usage and full setup instructions.
- **Canonical onboarding text** — Single source in `src/lib/onboarding.ts`: `CLI_USAGE`, `SETUP_INSTRUCTIONS`, `ONBOARDING_HINT_MISSING_ENV`. Reuse in CLI, MCP, docs.
- **Auto-onboarding on missing env** — Any invocation that fails due to a missing required env var (e.g. `zmail search "x"`, `zmail sync`) prints the error and then the full `SETUP_INSTRUCTIONS`, then exits 1. No need to run `zmail setup` first; the agent gets setup in one shot from the first failing command.
- **Local global install** — `npm run install-cli` runs `npm run build` then `npm install -g .` so `zmail` matches the published package layout (`dist/index.js`). See [AGENTS.md](../../AGENTS.md).

---

## Goals (remaining optional)

- **Stable release location** — Canonical install is `npm i -g zmail` (see OPP-007). Per-platform binaries or tarballs are optional.
- **Agent-first skill** — A Cursor/Codex-style skill that any agent can follow: install → configure (e.g. `zmail setup`) → verify. Single source of truth in AGENTS.md and onboarding.ts.
- **Minimal secrets** — User provides: Gmail address and a Gmail **app password** (not main password). Optional: `OPENAI_API_KEY` for semantic search. Everything else has sensible defaults.
- **Discoverability for LLMs** — Consider publishing an **llms.txt** in repo root so models have a dense, curated map of "what is zmail, how to install, how to configure."

---

## Workflow (target state)

### 1. Install the CLI

- **From npm:** `npm i -g zmail` (Node.js 20+). Canonical install; no binary download required.
- **From repo:** `npm run install-cli` is the preferred single command (`build` + `npm install -g .`).

### 2. Account setup

- Run `zmail setup` (interactive) or create `~/.zmail/config.json` and `~/.zmail/.env` with IMAP and optional OpenAI settings. See AGENTS.md.

### 3. Verify

- Run first sync: `zmail sync` (or `zmail sync --since 7d`). Optionally `zmail search "…"` to confirm search works.

### 4. Do not

- Commit `.env` or real credentials.
- Commit `data/` or `.db` (align with AGENTS.md).

---

## See also

- [AGENTS.md](../../AGENTS.md) — env vars, commands, onboarding behavior, single source of truth.
- [src/lib/onboarding.ts](../../src/lib/onboarding.ts) — canonical CLI usage and setup text (no deps).
- [OPP-007](archive/OPP-007-packaging-npm-homebrew.md) — packaging and distribution (npm, Node).
