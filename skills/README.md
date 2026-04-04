# User-facing skills (publishable)

Directories here are **[Agent Skills](https://agentskills.io/specification.md)-shaped** playbooks for **people who use zmail** (install, sync, search, `zmail ask`, etc.). They live in this repo and are also included in the **`@cirne/zmail`** npm tarball for copy-out; **install the CLI** with **`install.sh`** (Rust binary from GitHub Releases) — see **`AGENTS.md`**.

**Product skill name:** **`/zmail`** — the folder and frontmatter `name` are `zmail` (spec requirement); many hosts surface that as the **`/zmail`** slash command.

**Pitch:** Agent-native email for **Claude Code**, **OpenClaw**, and coding agents. **Local SQLite + FTS**—inbox-style **lightning-fast search**, answers as **structured JSON**, not a mail website. **Never leave** **agent / chat / terminal**: **zmail** CLI or MCP end-to-end. Let **AI** take care of search, summary, drafts, and send so you **never have to live in an inbox** again.

**Not the same as** **`.cursor/skills/`** in this repository — internal dev skills only (`commit`, `db-dev`, `install-local`, `process-feedback`).

| Path | Audience |
|------|-----------|
| [`zmail/`](zmail/) | Agents helping an **end user** run the **installed** CLI — not for editing this repo. |
| [`zmail/references/CANONICAL-DOCS.md`](zmail/references/CANONICAL-DOCS.md) | **CLI-first discovery** (`zmail --help`, per-command `--help`), **hints** in JSON/text output, and links to repo docs — prefer the live CLI over memorizing this README. |
| [`zmail/references/INBOX-CUSTOMIZATION.md`](zmail/references/INBOX-CUSTOMIZATION.md) | How to make **`zmail inbox`** smarter over time with durable rules and user context for notify/inform/archive/suppress behavior. |

## OpenClaw (this machine)

[OpenClaw — Creating skills](https://docs.openclaw.ai/tools/creating-skills) expects a directory with `SKILL.md` under a skills root (e.g. `<workspace>/skills/` or `~/.openclaw/skills/` — see [Skills](https://docs.openclaw.ai/tools/skills) for precedence).

From a **clone of this repo**, copy or symlink the whole **`skills/zmail/`** tree (not only `SKILL.md`; include `references/`):

```bash
ln -sf "$(pwd)/skills/zmail" ~/.openclaw/skills/zmail
```

If you use the **Node** dev tree, **`cd node && npm run install-skill:openclaw`** is still available. Override target: **`OPENCLAW_ZMAIL_SKILL_DIR`**.

## Claude Code (this machine)

[Claude Code — Skills](https://docs.claude.com/en/docs/claude-code/skills) loads skills from **`~/.claude/skills/`** (and project `.claude/skills/`). From a **clone of this repo**:

```bash
ln -sf "$(pwd)/skills/zmail" ~/.claude/skills/zmail
```

Legacy: **`cd node && npm run install-skill:claude`** (symlinks into **`~/.claude/skills/zmail`**). Override: **`ZMAIL_CLAUDE_SKILL_DIR`**. Copy instead of symlink: **`ZMAIL_CLAUDE_SKILL_MODE=copy`**.
