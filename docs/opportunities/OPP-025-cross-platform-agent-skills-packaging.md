# OPP-025: Conform to Agent Skills spec — packaging and platform map

**Status:** **Core artifact shipped** (2026-03-26) — [`skills/zmail/`](../../skills/zmail/) has valid YAML frontmatter (`name: zmail`), body + `references/`, and is linked from [AGENTS.md](../../AGENTS.md) as the publishable `/zmail` skill. **Remaining:** automation (`skills-ref validate` in CI or release checklist), manual smoke on Cursor/Claude/OpenClaw, optional README lead-in aligned with AGENTS skill-first ordering.

**Canonical target:** The **end-user** portable skill at [`skills/zmail/`](../../skills/zmail/) (in-repo; published **via npm package contents** alongside the CLI) should stay **conformant to the [Agent Skills specification](https://agentskills.io/specification.md)** as the spec and hosts evolve — not an informal markdown file. That means: required directory layout, valid `SKILL.md` YAML frontmatter, naming rules, optional `scripts/` / `references/` / `assets/`, and validation (e.g. [`skills-ref validate`](https://github.com/agentskills/agentskills/tree/main/skills-ref) per the spec). **Out of scope for this OPP:** [`.cursor/skills/`](../../.cursor/skills/) in this repo — internal dev skills (`commit`, `db-dev`, `install-local`, `process-feedback`), not the publishable **`/zmail`** user skill.

**Problem (reframed):** zmail is agent-first (CLI, MCP, docs), but products disagree on **where** skills live and **what else** they support **beyond** the [Agent Skills](https://agentskills.io/) baseline (extra frontmatter, gating, registries). If we own **one spec-conformant skill tree**, we get a clear bar for CI/docs and **one folder** to copy into Cursor, Claude Code, and OpenClaw — with small, documented deltas where a host’s parser or OpenClaw-specific `metadata` matters.

**Strategic tilt:** Prefer **install CLI + install spec-conformant skill** (instructions that steer subprocess `zmail`) over **MCP as the default onboarding path**. MCP stays **supported** for hosts and workflows that want persistent tool sessions. Docs and mental model should default **skill-first**.

**Example:** We publish `@cirne/zmail` on npm with **`skills/zmail/`** (frontmatter `name: zmail` → often invoked as **`/zmail`**): valid `SKILL.md` plus optional `references/`. **End users** copy that folder into **`~/.cursor/skills/zmail`**, **another project’s** `.cursor/skills/zmail`, **`~/.claude/skills/zmail`**, OpenClaw **`<workspace>/skills/zmail`** or **`~/.openclaw/skills/zmail`**, etc. — **not** into the zmail **upstream** repo’s `.cursor/skills/` (reserved for internal dev skills). MCP setup sits under **optional / advanced**.

---

## Spec conformance (what “done” means for the artifact)

Per [Agent Skills — Specification](https://agentskills.io/specification.md):

| Area | Requirement (summary) |
|------|------------------------|
| **Layout** | Skill is a **directory** with at minimum `SKILL.md`; optional `scripts/`, `references/`, `assets/`. |
| **Frontmatter** | Required: `name` (lowercase, hyphens, matches parent directory, length/charset rules), `description` (what + when, keywords for discovery). Optional: `license`, `compatibility`, `metadata`, experimental `allowed-tools`. |
| **Body** | Markdown instructions after frontmatter; keep main file focused; split detail into `references/` for progressive disclosure. |
| **Validation** | Run **`skills-ref validate ./zmail`** (or equivalent) in CI or release checklist when we adopt the tooling. |

**zmail-specific content rules** (on top of the spec): default to subprocess `zmail` commands; treat MCP as a short optional section pointing to [docs/MCP.md](../../docs/MCP.md). Keep [AGENTS.md](../../AGENTS.md), [docs/ASK.md](../../docs/ASK.md), and `onboarding.ts` as canonical detail; the skill is the **entry playbook**, not a duplicate manual.

---

## Which popular agents work with this spec?

The [Agent Skills](https://agentskills.io/) format is an **open, file-based** contract. **“Works with”** below means: the product **loads `SKILL.md` skills from disk** in a way that aligns with (or is intended to align with) that spec — not “any agent that can run shell,” though many can still **follow** the markdown if given the file.

| Product | Spec-conformant skill folder as **native** skill? | Notes |
|---------|---------------------------------------------------|--------|
| **Claude Code** | **Yes** (intended) | Documents skills in the Agent Skills open format; discovery under `.claude/skills/` and `~/.claude/skills/`. May support **extra** frontmatter beyond the spec — we should stay **spec-minimal** for portability and add Claude-only keys only if needed in a separate optional file or documented extension. See [Claude Code — skills](https://docs.claude.com/en/docs/claude-code/skills). |
| **Cursor** | **Yes** (practical) | Project/personal skill dirs with `SKILL.md` + frontmatter (`.cursor/skills/`, `~/.cursor/skills/`). Align our artifact with the spec so the same folder validates and ships everywhere; verify naming/path rules match Cursor’s docs as they evolve. |
| **OpenClaw** | **Yes** ([docs](https://docs.openclaw.ai/tools/skills)) | OpenClaw documents **[AgentSkills-compatible](https://agentskills.io/)** skill folders: a directory with `SKILL.md` (YAML frontmatter + instructions). Skills load from **bundled** install, **`~/.openclaw/skills`**, **`<workspace>/skills`** (workspace wins on name conflict), plus optional `skills.load.extraDirs` in `~/.openclaw/openclaw.json`. **[ClawHub](https://clawhub.com)** installs into workspace `./skills` by default. **Caveats:** format is “AgentSkills + Pi-compatible” — e.g. parser expects **single-line** frontmatter keys; `metadata` for OpenClaw gating is often a **single-line JSON** blob (`metadata.openclaw.requires.bins`, env, config). Use `{baseDir}` in instructions for the skill folder path. Skills are **filtered at load time** (bins, env, config). **MCP** (`zmail mcp`) remains optional for tool-session ergonomics, not a substitute for the skill folder story. |
| **Other IDEs / assistants** | **Varies** | Any environment that discovers markdown skills on disk may align over time; anything **without** skill discovery still benefits from a **validated, stable** folder to paste or bundle. |

**Bottom line:** **Claude Code**, **Cursor**, and **OpenClaw** can all consume **one** spec-validated **`SKILL.md` skill directory**; document **install paths** and **OpenClaw-only** frontmatter/gating only where we need binary presence (`zmail` on `PATH`) or env hints.

---

## Why prefer skill (+ CLI) over MCP as default

Skills and MCP solve different layers (instructions vs protocol). For **end-user packaging**, spec-conformant skill + CLI wins on:

| Dimension | Skill-first (spec `SKILL.md` + `zmail` CLI) | MCP-first (`zmail mcp`) |
|-----------|---------------------------------------------|-------------------------|
| **Install surface** | npm + copy skill dir; no MCP registration | Per-client MCP config, stdio, env, restarts |
| **Portability** | Same validated tree for Claude Code + Cursor + OpenClaw (skill dirs) | Each MCP host has its own config shape |
| **Debugging** | `zmail status`, CLI-shaped logs | Server lifecycle, transport, tool sync |
| **Contract** | [Agent Skills spec](https://agentskills.io/specification.md) | zmail MCP contract ([docs/MCP.md](../../docs/MCP.md)) |

**Tradeoffs:** Subprocess CLI can mean more round-trips than batched MCP tools; mitigations include richer CLI output and `zmail ask` ([OPP-018](archive/OPP-018-reduce-agent-round-trips.md), archived). We are **not** deleting MCP — we **reorder defaults** and reduce mandatory MCP surface.

---

## Platform notes (install locations, publishing)

Details may evolve as vendors ship updates; the **artifact** stays spec-bound.

### Cursor

- **Where:** `.cursor/skills/<skill-name>/` or `~/.cursor/skills/<skill-name>/`.
- **Publishing:** No central store in core docs — distribute **files** (git, tarball, **npm as carrier**) + document copy/symlink targets.

### Claude Code

- **Where:** `.claude/skills/<name>/` or `~/.claude/skills/<name>/`.
- **Publishing:** Same — **files on disk**; optional ecosystem indexes are not our source of truth.

### OpenClaw

Per [OpenClaw — Skills](https://docs.openclaw.ai/tools/skills):

- **Format:** **AgentSkills-compatible** directory + `SKILL.md` (plus optional `scripts/`, etc.), aligned with [agentskills.io](https://agentskills.io/specification.md) layout/intent; OpenClaw adds **Pi-compatible** parsing rules and optional frontmatter (`user-invocable`, `command-dispatch`, …).
- **Where (precedence high → low):** `<workspace>/skills` → `~/.openclaw/skills` → bundled skills; optional lowest-precedence dirs via `skills.load.extraDirs`.
- **Distribution:** [ClawHub](https://clawhub.com) (`clawhub install …`, sync/update flows); plugins can ship skills via `openclaw.plugin.json`.
- **Gating:** `metadata.openclaw` can require bins on `PATH`, env vars, or config paths — useful to **hide** the zmail skill until `zmail` is installed (or document install in-body).
- **MCP:** Still optional — use when users want **`zmail mcp`** tool batching alongside skills.

---

## Fragmentation at a glance

| Platform | Loads spec `SKILL.md` skill dir? | Typical location | zmail default story |
|----------|----------------------------------|------------------|---------------------|
| **Cursor** | Yes | `.cursor/skills/` or `~/.cursor/skills/` | Spec skill + CLI; MCP optional |
| **Claude Code** | Yes | `.claude/skills/` or `~/.claude/skills/` | Same folder + CLI; MCP optional |
| **OpenClaw** | Yes (AgentSkills-compatible) | `<workspace>/skills`, `~/.openclaw/skills`, bundled | Same folder + CLI; optional `metadata.openclaw` for `zmail` bin; MCP optional |

---

## Migration: MCP → skill-first defaults

**Current state:** Many users/agents discover zmail via **MCP**; AGENTS.md documents CLI and MCP.

**Target state:**

1. **Onboarding** leads with **spec-conformant skill + CLI**; MCP under **Optional: MCP**.
2. **npm** ships the skill directory via `package.json` `files`; documented paths for **Cursor, Claude Code, and OpenClaw** (`~/.openclaw/skills` / workspace `skills/`, or ClawHub publish flow if we choose it).
3. **OpenClaw:** document **skill folder** install alongside optional **MCP**; call out **gating** (`requires.bins: ["zmail"]`) if we add OpenClaw-specific `metadata`.
4. **No rushed MCP removal** — narrative and ordering first; validate skill flows in real sessions before any breaking change.

**Phasing (suggested):**

| Phase | What changes |
|-------|----------------|
| **0 — Now** | This doc; **`skills/zmail/`** layout + frontmatter **done**; `skills-ref validate` still optional. |
| **1** | **`skills/zmail/`** in repo + npm — **done** (verify `npm pack` / published tarball includes `skills/`). Contributors dogfood via **personal** `~/.cursor/skills/zmail` — **never** replace this repo’s internal `.cursor/skills/*` dev folders with the user skill. |
| **2** | AGENTS.md: **skill + CLI first** — **done** (Key documents). README: still mixed; align when convenient. |
| **3** | OpenClaw: verify skill paths + optional gating metadata; keep MCP docs for users who want both. |
| **4** | Reassess MCP emphasis vs metrics. |

---

## Proposed directions

1. **Single spec-conformant skill directory**  
   - **Canonical path in-repo:** [`skills/zmail/`](../../skills/zmail/) (directory name = frontmatter `name`: `zmail`).  
   - Validate with **`skills-ref validate`** in CI or pre-publish checklist.  
   - Optional `references/` for deep links to repo docs (progressive disclosure per spec).  
   - **npm:** tarball already includes `skills/zmail` (no `files` whitelist today); document copy to `~/.cursor/skills/zmail`, `~/.claude/skills/zmail`, and OpenClaw **`~/.openclaw/skills/zmail`** or **`<workspace>/skills/zmail`**.

2. **OpenClaw**  
   - Same **spec-conformant folder** as other hosts; optionally add **`metadata.openclaw`** (single-line JSON per OpenClaw docs) for `requires.bins: ["zmail"]` once global/npm install guarantees `PATH`.  
   - Optional: publish or document **ClawHub** install for discoverability — still the same `SKILL.md` tree, not a second format.

3. **Optional CLI helper (later)**  
   - e.g. `zmail skill-path` or `zmail skill-install --target cursor|claude|openclaw` — opt-in only (no silent writes to home).

4. **DRY**  
   - Short `SKILL.md` body; one MCP subsection; canonical prose stays in AGENTS.md / docs.

---

## Relationship to prior work

- [OPP-005 (archived)](archive/OPP-005-onboarding-claude-code.md): “Agent-first skill” — this opportunity makes the **Agent Skills spec** the explicit bar; **OpenClaw** also loads AgentSkills-compatible folders ([docs](https://docs.openclaw.ai/tools/skills)), with optional host-specific `metadata`.
- **Internal** Cursor skills (this repo only): [.cursor/skills/](../../.cursor/skills/) — separate from **`skills/zmail/`** (publishable **`/zmail`**).

---

## Risks and unknowns

- **Spec vs vendor extensions:** Claude, OpenClaw, etc. may add frontmatter or parsing rules — mitigate with **spec-minimal** core; add **OpenClaw `metadata.openclaw`** only in a way that still validates or lives in a documented optional snippet.  
- **OpenClaw parser constraints:** Single-line keys / single-line JSON `metadata` per [their docs](https://docs.openclaw.ai/tools/skills) — multi-line YAML maps may need adjustment for OpenClaw even if valid elsewhere.  
- **Security:** Emphasize official paths (npm scope, repo); same `.env` hygiene as MCP.  
- **Latency:** More CLI invocations vs MCP batching — see [OPP-018](archive/OPP-018-reduce-agent-round-trips.md).

---

## Test / acceptance criteria

- [x] Opportunity doc + index entry in [OPPORTUNITIES.md](../OPPORTUNITIES.md).  
- [x] Spec-shaped **`skills/zmail/`** (`SKILL.md` + `references/`) in repository.  
- [ ] Shipped skill directory passes **`skills-ref validate`** (or adopted equivalent) in CI or pre-publish.  
- [ ] Manual smoke: copy into Cursor + Claude Code skill dirs; discovery via description.  
- [ ] Manual smoke (OpenClaw): install skill into `~/.openclaw/skills` or workspace `skills/`; confirm load + optional bin gating.  
- [x] AGENTS.md: skill + CLI called out in Key documents (skill-first narrative).  
- [ ] README: lead with skill + CLI before MCP (optional polish).  
- [ ] OpenClaw: skill install path + optional MCP verified against a current OpenClaw release (version noted).

---

## References

- [Agent Skills — Specification](https://agentskills.io/specification.md)  
- [Agent Skills overview](https://agentskills.io/)  
- [skills-ref (validate)](https://github.com/agentskills/agentskills/tree/main/skills-ref)  
- [Claude Code — Extend Claude with skills](https://docs.claude.com/en/docs/claude-code/skills)  
- [OpenClaw — Skills](https://docs.openclaw.ai/tools/skills)  
- [ClawHub](https://clawhub.com)  
- [anthropics/skills (examples)](https://github.com/anthropics/skills)  
- zmail: [AGENTS.md](../../AGENTS.md), [docs/MCP.md](../../docs/MCP.md)
