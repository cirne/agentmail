# User-facing skills (publishable)

Directories here are **[Agent Skills](https://agentskills.io/specification.md)-shaped** playbooks for **people who use zmail** (install, sync, search, `zmail ask`, etc.). They ship with the npm package and can be copied into **end-user** agent skill paths or published to registries (e.g. ClawHub).

**Product skill name:** **`/zmail`** — the folder and frontmatter `name` are `zmail` (spec requirement); many hosts surface that as the **`/zmail`** slash command.

**Not the same as** **`.cursor/skills/`** in this repository — internal dev skills only (`commit`, `db-dev`, `install-local`, `process-feedback`).

| Path | Audience |
|------|-----------|
| [`zmail/`](zmail/) | Agents helping an **end user** run the **installed** CLI — not for editing this repo. |
| [`zmail/references/CANONICAL-DOCS.md`](zmail/references/CANONICAL-DOCS.md) | **CLI-first discovery** (`zmail --help`, per-command `--help`), **hints** in JSON/text output, and links to repo/npm docs — prefer the live CLI over memorizing this README. |

## OpenClaw (this machine)

[OpenClaw — Creating skills](https://docs.openclaw.ai/tools/creating-skills) expects a directory with `SKILL.md` under a skills root (e.g. `<workspace>/skills/` or `~/.openclaw/skills/` — see [Skills](https://docs.openclaw.ai/tools/skills) for precedence).

From a **clone of this repo**, copy the whole **`skills/zmail/`** tree (not only `SKILL.md`; include `references/`):

```bash
npm run install-skill:openclaw
```

Default target: **`~/.openclaw/skills/zmail`**. Override with **`OPENCLAW_ZMAIL_SKILL_DIR`** if your workspace uses another path (example from the docs: `~/.openclaw/workspace/skills/zmail`):

```bash
OPENCLAW_ZMAIL_SKILL_DIR="$HOME/.openclaw/workspace/skills/zmail" npm run install-skill:openclaw
```

Preview: `npm run install-skill:openclaw -- --dry-run`. Then start a new session or restart the gateway so OpenClaw reloads skills.
