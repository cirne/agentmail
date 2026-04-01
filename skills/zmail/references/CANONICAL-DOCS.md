# Canonical docs and how agents should learn zmail

This file is for the **end-user `/zmail` skill** (`skills/zmail/`). For **developing** zmail in Cursor, use the repo’s **`.cursor/skills/`** (`commit`, `db-dev`, `install-local`, `process-feedback`) — not this playbook.

---

## Prefer the live CLI over static cheat sheets

**Treat the installed `zmail` binary as the source of truth** for commands, flags, and defaults. Markdown in the repo or this skill can lag a release; the CLI cannot.

**Discovery order (recommended):**

1. **`zmail`**, **`zmail --help`**, **`zmail -h`**, or **`zmail help`** — short command list (**Rust** source: **`src/cli/root_help.txt`**, **`src/main.rs`**). Reference copy: **`node/src/lib/onboarding.ts`** (`CLI_USAGE`) may lag. **`zmail --version`** — version plus **`install.sh`** upgrade/reinstall one-liners (see **`AGENTS.md`**); **`zmail -V`** — version only. Workflows (e.g. **`zmail ask`** vs primitives, **draft + send**, MCP): **`docs/ASK.md`**, **`docs/MCP.md`**, **`skills/zmail/references/DRAFT-AND-SEND.md`**, **`skills/zmail/references/AUTH-CODES.md`**, **`SKILL.md`** § Agent workflow.
2. **`zmail <command> --help`** — flags and examples for that command (e.g. `zmail search --help`, `zmail who --help`, `zmail attachment list --help`).
3. **Run a command** and read the **structured output** — zmail **embeds hints** so you learn the next step without opening docs (see below).

Top-level help and **install/upgrade** text are maintained in the **Rust** CLI (`src/cli/root_help.txt`, long `zmail --version` text in `src/main.rs`). **`node/.../onboarding.ts`** is a reference copy only. When in doubt, run the **Rust** binary or compare this skill to **`AGENTS.md`**.

---

## Progressive disclosure in CLI output (read the `hint`)

zmail is designed so **the tool teaches its own capabilities** as you use it.

- **JSON (default for `search`, `who`, `attachment list`):** Responses are often an object with **`results`** plus optional metadata. Look especially for:
  - **`hint`** — short guidance (narrower query, attachments, pagination, batch-style follow-ups, etc.).
  - **`truncated`**, **`totalMatched`**, **`returned`** — whether you are seeing a slice of a larger result set; combine with **`--limit`** / flags from **`zmail search --help`**.
- **Text / table mode (`--text`):** Some commands print a **trailing tip** after results (same ideas as JSON hints).
- **Typos / wrong verbs:** Unknown subcommands get a **compact correction** (e.g. suggesting `update`, `read`, `search`, `ask`, `check`, `review`).
- **Missing config:** You get an explicit pointer to **`zmail setup`** / **`zmail wizard`** — no silent failure.

**Agent habit:** After every `zmail` call, if the payload includes **`hint`**, follow it before guessing a new command.

---

## Markdown references (repository or npm package layout)

Paths below are relative to the **repository root** or, if you use the legacy npm package, the **installed `@cirne/zmail` package root** (parent of `skills/zmail/`). From a clone, use paths as written. From npm:

`$(npm root -g)/@cirne/zmail/AGENTS.md` (exact layout depends on npm version and OS).

| Topic | Path | Notes |
|--------|------|--------|
| **Full agent guide** — commands, env, sync, MCP overview | `AGENTS.md` | Primary maintainer-facing index; keep skill content thin and link here. |
| **Vision** — agent-first product goals | `docs/VISION.md` | Why zmail exists; not a command reference. |
| **`ask` vs primitives** — orchestration, hybrid patterns | `docs/ASK.md` | When `zmail ask` wins vs `search`/`read`/…; complements `--help`. |
| **Draft + send** — agent compose/reply/forward, CLI vs MCP | `skills/zmail/references/DRAFT-AND-SEND.md` | Shipped with the skill; high-level in `SKILL.md` § Agent workflow. |
| **Login / OTP / verification codes** — update + search + read, MCP | `skills/zmail/references/AUTH-CODES.md` | Shipped with the skill; high-level in `SKILL.md` § Login / OTP / verification codes. |
| **Inbox customization** — durable rules, context, triage memory | `skills/zmail/references/INBOX-CUSTOMIZATION.md` | How agents should maintain inbox rules/context so `zmail check` and `zmail review` get smarter over time. |
| **Architecture** — SQLite, sync, indexing decisions | `docs/ARCHITECTURE.md` | Read before changing storage or sync behavior. |
| **MCP** — tools, params, token-efficient patterns | `docs/MCP.md` | Same index as CLI; hints in JSON sometimes align with MCP batch patterns. |
| **Skill packaging** — spec, hosts, `skills/zmail/` layout | `docs/opportunities/OPP-025-cross-platform-agent-skills-packaging.md` | Strategy for `/zmail` vs internal Cursor skills. |

**DRY:** Prefer updating **`AGENTS.md`**, **`docs/*.md`**, or the **Rust** CLI (`src/main.rs`, `src/cli/root_help.txt`) rather than duplicating long command lists in **`SKILL.md`** or this file. Optionally sync **`node/.../onboarding.ts`** for npm parity.

---

## MCP

For a **persistent tool** connection (instead of subprocess CLI), run **`zmail mcp`** and use the tools described in **`docs/MCP.md`**. CLI and MCP share the same index; conceptual detail (e.g. ask vs primitives) lives in **`docs/ASK.md`** and this skill, not in top-level **`zmail --help`**.
