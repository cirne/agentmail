# OPP-025: Cross-Platform Agent Skills — Cursor, Claude Code, OpenClaw

**Status:** Open (research + proposal). No implementation commitment yet.

**Problem:** zmail is agent-first (CLI, MCP, docs), but **agent products disagree on what a “skill” is**, where it lives, and how it is **published**. Shipping “one skill” that works in Cursor, Claude Code, and OpenClaw requires a deliberate packaging story—not a single universal install path.

**Strategic tilt (this doc):** Treat **migrating from MCP toward skills as the preferred packaging and usage model** for agents: primary onboarding should be **install CLI + install skill** (markdown playbook that steers `zmail` subprocess use), not **wire up an MCP server**. MCP remains **supported** for hosts and workflows that benefit from persistent tool sessions, but docs, examples, and mental model should **default to skill-first**.

**Example:** We publish `@cirne/zmail` on npm and want agents to **default** to a bundled or copied **`SKILL.md`** that teaches install, config, `zmail search` / `zmail ask`, and background sync—without requiring MCP client configuration. MCP setup moves to an **advanced / optional** section (and stays essential for some OpenClaw deployments until a native or shell-backed skill story exists there).

---

## Why prefer skill over MCP (for zmail)

Skills and MCP solve different layers (instructions vs protocol), but **for end-user packaging** the skill-first model wins on several axes:

| Dimension | Skill-first (`SKILL.md` + `zmail` CLI) | MCP-first (`zmail mcp`) |
|-----------|----------------------------------------|-------------------------|
| **Install surface** | npm global (or wrapper) + copy skill folder; no IDE/host MCP config | Per-client MCP registration, stdio paths, env injection, restarts |
| **Portability** | Same playbook in Cursor, Claude Code, any agent that runs shell | Each MCP host has its own config shape and discovery |
| **Debugging** | User/agent runs `zmail status`; logs are CLI-shaped | Extra hop: server lifecycle, transport, tool list sync |
| **Alignment** | Matches [Agent Skills](https://agentskills.io/) “instructions + optional scripts” | zmail-specific server contract ([docs/MCP.md](../../docs/MCP.md)) |

**Tradeoffs to own:** A subprocess CLI can mean **more discrete tool-like steps** from the outer LLM’s perspective than a single MCP session with many tools; that cost is partially addressed by richer CLI output and `zmail ask` (see [OPP-018](OPP-018-reduce-agent-round-trips.md)). The migration is **not** “delete MCP”—it is **reorder defaults** and **reduce mandatory MCP surface** for typical agent users.

---

## Research summary (2026-03)

Primary sources are linked; details may evolve as vendors ship updates.

### 1. Cursor — “Skills” as markdown on disk

- **What:** Skills are **directories** containing a required **`SKILL.md`** with YAML frontmatter (`name`, `description`, …) and a markdown body. Optional siblings: reference files, `scripts/`, etc.
- **Discovery:** The agent uses the **description** (and context) to decide when to load a skill; content is not fetched from a central registry by the authoring docs we use internally.
- **Where:** **Project:** `.cursor/skills/<skill-name>/`. **Personal:** `~/.cursor/skills/<skill-name>/`. (Cursor’s built-in skills live under a separate managed path; third-party skills should not be placed there.)
- **Publishing:** There is **no** npm-integrated “Cursor skill store” in the documented model. Distribution = **ship files** (git repo, tarball, npm package as a **carrier**) + **document** where to copy or symlink them.

**Implication for zmail:** Keep a **portable skill folder** in-repo (already aligned with `.cursor/skills/`) and optionally **publish the same files** inside the npm tarball with documented install paths.

---

### 2. Claude Code — Agent Skills (open format) + extensions

- **Standard:** Claude Code documents skills as following the **[Agent Skills](https://agentskills.io/)** open format: folders of instructions, optional scripts/resources, intended for **cross-product** reuse ([overview](https://agentskills.io/); spec lives in the [agentskills/agentskills](https://github.com/agentskills/agentskills) repo).
- **What:** Same core idea as Cursor: **`SKILL.md`** with frontmatter + body; supporting files referenced from `SKILL.md`.
- **Discovery:** Claude can load skills **when relevant** from the description, or the user can invoke **`/skill-name`**. Nested monorepo discovery: `.claude/skills/` in subdirectories may be picked up when working in those trees ([Claude Code skills docs](https://docs.claude.com/en/docs/claude-code/skills)).
- **Where:** **Personal:** `~/.claude/skills/<name>/`. **Project:** `.claude/skills/<name>/`. **Enterprise / plugins:** additional locations per vendor docs.
- **Publishing:** Same pattern as Cursor—**files on disk**. Optional ecosystem directories (third-party indexes) exist outside Anthropic; they are **not** a substitute for a canonical source of truth in our repo or npm package.

**Claude-specific extensions** (may not port to other tools): e.g. `allowed-tools`, `disable-model-invocation`, subagent/`context` options—see [frontmatter reference](https://docs.claude.com/en/docs/claude-code/skills). A **portable** zmail skill should use a **minimal** frontmatter set that still works if copied to Cursor.

---

### 3. OpenClaw — Native “skills” vs MCP “plugins”

OpenClaw’s docs draw a **sharp line** between capability types ([Skills & ClawHub](https://learnopenclaw.com/core-concepts/skills)):

| Concept | Meaning in OpenClaw |
|--------|----------------------|
| **Built-in tools** | Core tools shipped with the product (~20). |
| **Skills** | **OpenClaw-native** extensions: workspace `skills/` directory, registered in **`openclaw.json`**, often installed from **ClawHub** via `/skills install @author/name`. Custom skills use a **manifest** (`manifest.json`), entry module (`index.js` / `index.py`), declared **tools** and **permissions**—closer to a **sandboxed app** than a single markdown file. |
| **Plugins** | **MCP-based** integrations—general interoperability with MCP servers (including those built for other clients). |

**Implication for zmail (migration-aware):** Today, **`zmail mcp`** is the **straightforward** OpenClaw path as an MCP **plugin**. Under a **skill-first** strategy, that is an **intermediate** state: **preferred long-term** is either (a) a **native** OpenClaw skill that wraps or shells out to `zmail` with a minimal manifest, or (b) documented **shell + markdown** usage (agent runs `zmail` via built-in shell tools) plus a portable `SKILL.md`—so users are not **required** to maintain MCP wiring for basic email access. MCP stays valid for deep tool integration until (a) or (b) is shipped.

**Publishing:** ClawHub supports **`/skills publish`** for native skills. MCP servers are configured per deployment (e.g. `openclaw.json` / managed UI)—not the same pipeline as dropping a `SKILL.md` into `.cursor/skills/`. **Migration:** invest in **one** native or documented shell-backed path rather than treating MCP as the only “real” integration.

---

## Fragmentation at a glance

| Platform | Primary artifact | Typical location | Registry / marketplace | **Target** zmail integration (skill-first) |
|----------|------------------|------------------|-------------------------|------------------------------------------|
| **Cursor** | `SKILL.md` + optional files | `.cursor/skills/` or `~/.cursor/skills/` | None in core docs; file-based | **Default:** markdown skill + subprocess `zmail`. MCP: optional. |
| **Claude Code** | `SKILL.md` (+ optional extras) | `.claude/skills/` or `~/.claude/skills/` | Agent Skills ecosystem + file-based | **Default:** same portable skill + CLI. MCP: optional. |
| **OpenClaw** | Native: `manifest.json` + code; MCP: server config | `skills/` + `openclaw.json` | ClawHub for native skills | **Today:** MCP plugin is practical. **Target:** native skill or shell-backed playbook so MCP is not the only path. |

---

## Migration: MCP → skill as preferred model

**Current state:** Many agents discover zmail through **MCP** ([docs/MCP.md](../../docs/MCP.md)); AGENTS.md documents both CLI and MCP.

**Target state:**

1. **Documentation and onboarding** lead with **skill + CLI** (install `@cirne/zmail`, copy/symlink skill, `zmail setup`, `zmail search` / `zmail ask`). MCP is documented under **“Optional: MCP”** with clear use cases (persistent IDE integration, hosts that strongly prefer MCP tools, batch tool ergonomics).
2. **Packaging** ships a **first-class skill directory** in the npm tarball and repo; MCP remains a **code path** we maintain but not the **primary** story for new users.
3. **OpenClaw** moves from “MCP only” to “skill or native extension preferred” over time—either a **thin native skill** invoking the CLI or ClawHub-published package that wraps zmail; MCP documented as **legacy / power-user** until parity.
4. **No rushed removal:** MCP deprecation is **narrative and ordering** first; breaking changes only after skill-based flows are validated in real agent sessions.

**Phasing (suggested):**

| Phase | What changes |
|-------|----------------|
| **0 — Now** | Research + this doc; optional in-repo skill path experiment. |
| **1** | Canonical `SKILL.md` in repo + npm `files`; AGENTS.md / README “preferred: skill + CLI.” |
| **2** | MCP section retitled advanced; MCP tools unchanged. |
| **3** | OpenClaw: evaluate native skill or documented shell playbook; reduce dependence on MCP for basic queries. |
| **4** | Reassess MCP long-term: keep for compatibility vs slim surface (only if metrics show skill-only suffices). |

---

## Proposed directions (for zmail)

1. **Canonical markdown skill as the primary artifact (Cursor + Claude Code)**  
   - Maintain **one** skill body under a stable path, e.g. `extras/agent-skills/zmail/` or `skills/zmail/` at repo root, with `SKILL.md` validated against the **Agent Skills** spec.  
   - **Symlink or duplicate** into `.cursor/skills/zmail/` for repo contributors if we want zero drift.  
   - **npm:** Add the folder to `package.json` `files` so global installs expose `SKILL.md`; document **copy** to `~/.cursor/skills/` and `~/.claude/skills/`.  
   - **Content default:** subprocess `zmail` commands; **do not** present MCP as step zero.

2. **OpenClaw: parallel track off MCP-only**  
   - **Short term:** Keep MCP plugin instructions for users who already use MCP.  
   - **Skill-first alignment:** Document **running `zmail` via shell** under the same playbook where the host allows it; pursue **native** OpenClaw skill (manifest + thin wrapper) or ClawHub publication so “install skill” does not imply “configure MCP.”

3. **Optional CLI helper (later)**  
   - e.g. `zmail skill-path` printing the bundled skill directory, or `zmail skill-install --target cursor|claude` copying into user skill dirs—**opt-in** to avoid surprising `postinstall` writes to home directories.

4. **Cross-links and DRY**  
   - `SKILL.md` stays **short**: triggers, command cheat sheet, setup, when to use `zmail ask`. **MCP:** one subsection—“use when your environment already uses MCP or you need …” Canonical detail remains **AGENTS.md**, **docs/MCP.md**, **docs/ASK.md**, **onboarding.ts**—with **ordering** updated so skill-first readers meet CLI before MCP.

---

## Relationship to prior work

- [OPP-005 (archived)](archive/OPP-005-onboarding-claude-code.md) listed an **“Agent-first skill”** as an optional remaining goal; this opportunity refines that into a **multi-platform** packaging and terminology map.
- In-repo Cursor skills today: [.cursor/skills/](../../.cursor/skills/).

---

## Risks and unknowns

- **Spec drift:** Agent Skills spec vs Claude-only frontmatter fields—mitigate with minimal portable frontmatter and product-specific optional files if needed.  
- **OpenClaw evolution:** Marketplace and skill format may change; native skill work is **extra** surface until we commit; MCP remains the reliable bridge meanwhile.  
- **Security narrative:** OpenClaw explicitly warns about **malicious skills**; zmail’s story should emphasize **reviewed** official paths (npm scope, GitHub paths). Shell-based usage still needs the same **don’t exfiltrate `.env`** guidance as MCP.  
- **Latency / round-trips:** Skill-first often means **more CLI invocations** than batched MCP tools for some workflows; mitigations are richer CLI output, `zmail ask`, and optional MCP for users who need tool batching—see [OPP-018](OPP-018-reduce-agent-round-trips.md).

---

## Test / acceptance criteria (documentation deliverable)

- [x] One opportunity doc (this file) + index entry in [OPPORTUNITIES.md](../OPPORTUNITIES.md).  
- [ ] When implemented: `SKILL.md` passes any **Agent Skills** validator the project adopts; manual smoke: copy skill to Cursor and Claude Code and confirm discovery via description match.  
- [ ] AGENTS.md / README reflect **skill + CLI first**, MCP second (acceptance: new reader hits skill path before MCP).  
- [ ] OpenClaw: document **both** transitional MCP steps and **target** native/shell-backed path when available; verify MCP steps against a current OpenClaw release (version noted in doc).

---

## References

- [Agent Skills overview](https://agentskills.io/)  
- [Claude Code — Extend Claude with skills](https://docs.claude.com/en/docs/claude-code/skills)  
- [OpenClaw — Skills & ClawHub](https://learnopenclaw.com/core-concepts/skills)  
- [anthropics/skills (examples)](https://github.com/anthropics/skills)  
- zmail: [AGENTS.md](../../AGENTS.md), [docs/MCP.md](../../docs/MCP.md)
