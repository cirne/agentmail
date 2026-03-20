# Canonical documentation (repo / npm package root)

This file supports the **end-user** **`/zmail`** skill (`skills/zmail/`). For **developing** zmail in Cursor, see repo **`.cursor/skills/`** (`commit`, `db-dev`, `install-cli`, `process-feedback`).

Paths are relative to the **repository or npm package root** (parent of `skills/zmail/`).

| Topic | Path |
|--------|------|
| Full agent guide (commands, env, onboarding) | `AGENTS.md` |
| Product vision (“agent-first email”, why zmail) | `docs/VISION.md` |
| When to use `zmail ask` vs primitives | `docs/ASK.md` |
| Architecture / SQLite / sync | `docs/ARCHITECTURE.md` |
| Skill packaging strategy | `docs/opportunities/OPP-025-cross-platform-agent-skills-packaging.md` |

**DRY:** Prefer updating `AGENTS.md`, `docs/*.md`, or `src/lib/onboarding.ts` (`CLI_USAGE`) rather than duplicating long command lists in `SKILL.md`.
