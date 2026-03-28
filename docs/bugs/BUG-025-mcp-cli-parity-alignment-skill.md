# BUG-025: MCP Should Match CLI Capabilities — Plus a Project Skill to Validate Alignment

**Status:** Open. **Created:** 2026-03-28. **Tags:** mcp, cli, agent-first, parity, docs, testing

**Design lens:** [Agent-first](../VISION.md) — Agents discover zmail through **CLI**, **MCP**, and **skills/docs**. Surfaces that claim to access “the same mailbox” must not diverge in **capabilities** without an explicit, documented exception. Gaps that were justified as “shipping order” or “performance hypothesis” are no longer acceptable as permanent product shape: **if the CLI can do it, MCP should expose it** (or we document a narrow, reviewed exception and the reason endures scrutiny).

---

## Summary

- **Observed:** MCP lacks parity with the CLI for important agent workflows. Examples called out in repo docs today:
  - **`zmail ask`** — natural-language answer engine exists on CLI; **no MCP tool** wraps the same pipeline ([OPP-020](../opportunities/OPP-020-answer-engine-local-agent.md) defers `ask_email` or similar).
  - **Drafts** — MCP has `create_draft`, `list_drafts`, `send_draft`, `send_email`, but **not** the CLI’s LLM **`draft edit`** or literal **`draft rewrite`** paths ([OPP-011](../opportunities/OPP-011-send-email.md), [`docs/MCP.md`](../MCP.md)).
- **Expected:** For every **agent-facing** CLI capability (read/query, compose/send, answer), MCP exposes an equivalent tool **or** a single documented exception with user-visible rationale and a tracked follow-up. Subprocess-to-CLI should be a **fallback**, not the default story for core loops.
- **Process:** Add a **project-specific Cursor skill** (under [`.cursor/skills/`](../.cursor/skills/)) that instructs agents how to **validate CLI/MCP alignment** on demand (inventory, param parity, behavioral smoke checks, doc cross-checks).

---

## Why this is a bug (not an opportunity)

Parity bugs create **silent footguns**: agents configured for MCP assume feature completeness, fail or fork to shell unpredictably, and users get inconsistent behavior across hosts. That undermines “agent-first” more than missing a niche optimization.

---

## Scope (concrete alignment targets)

1. **`ask` / answer engine**
   - Add an MCP tool (name TBD, e.g. `ask_email`) that runs the **same** internal pipeline as `zmail ask` (same inputs, env, and failure modes), with JSON-oriented output suitable for tools.
   - Update [`docs/MCP.md`](../MCP.md), [`AGENTS.md`](../AGENTS.md) tool lists, and publishable skill references if they describe MCP.

2. **Draft LLM edit and literal rewrite**
   - Add MCP tools (or extend `create_draft`) so agents can perform **natural-language revision** and **literal rewrite** equivalent to `zmail draft edit` and `zmail draft rewrite` without shelling out.
   - Reuse shared implementation in [`src/send/`](../../src/send/) and CLI entrypoints; avoid duplicate business logic.

3. **Param / option parity (mechanical)**
   - Extend the pattern in [`src/mcp/cli-mcp-sync.test.ts`](../../src/mcp/cli-mcp-sync.test.ts) and exported `MCP_*_PARAM_KEYS` so **every** CLI option that maps to a shared layer is reflected in MCP where intended (search/who already partially covered; draft/send/ask should be included after tools land).

4. **Documentation**
   - Remove or narrow “CLI-only” language in [`docs/MCP.md`](../MCP.md) and [`skills/zmail/SKILL.md`](../../skills/zmail/SKILL.md) once parity is shipped; keep only **true** exceptions.

---

## Project skill: validate CLI/MCP alignment

Add **`.cursor/skills/cli-mcp-alignment/SKILL.md`** (name can be adjusted to match repo naming conventions) that tells agents:

- **Inventory:** Enumerate CLI subcommands and flags from code/help (`CLI_USAGE`, `src/cli/`) vs MCP tool names and schemas (`src/mcp/index.ts`, `docs/MCP.md`).
- **Contract checks:** Point to `cli-mcp-sync.test.ts` and `MCP_*_PARAM_KEYS`; when adding CLI options, update MCP and tests in the same change.
- **Behavioral smoke (when appropriate):** Same fixture DB or temp `ZMAIL_HOME`, invoke CLI JSON output vs MCP handler or integration test patterns used in [`src/mcp/*.test.ts`](../../src/mcp/).
- **Doc cross-check:** Diff user-facing tables (e.g. [`skills/zmail/references/DRAFT-AND-SEND.md`](../../skills/zmail/references/DRAFT-AND-SEND.md)) against implemented tools.
- **Escalation:** If intentional divergence remains, file/update a bug or ADR note — not silent drift.

The skill is for **human and agent auditors** during PR review, releases, or refactors; it **complements** automated tests, it does not replace them.

---

## Acceptance criteria (when closing)

- [ ] MCP exposes `ask`-equivalent and draft **edit**/**rewrite**-equivalent capabilities, or this bug is split into tracked children with explicit remaining scope.
- [ ] `docs/MCP.md` and agent-facing skill/docs reflect the new tools; “use CLI for X” is only where we still explicitly defer.
- [ ] Tests: unit/integration coverage for new MCP paths; extend param-sync (or equivalent) for new tool option sets.
- [ ] **`.cursor/skills/...`** skill exists and is linked from [`AGENTS.md`](../AGENTS.md) (e.g. Development rules or Commands) so contributors find it.
- [ ] Optional: one-shot npm script or documented `npm test` subset that agents can run for “MCP parity” smoke (only if low cost).

---

## References

- MCP implementation: [`src/mcp/index.ts`](../../src/mcp/index.ts)
- Existing CLI/MCP param sync test: [`src/mcp/cli-mcp-sync.test.ts`](../../src/mcp/cli-mcp-sync.test.ts)
- Draft/send architecture: [ADR-024](../ARCHITECTURE.md#adr-024-outbound-email--smtp-send-as-user--local-drafts) in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md)
- Prior deferral context (to supersede): [OPP-020](../opportunities/OPP-020-answer-engine-local-agent.md), [OPP-011](../opportunities/OPP-011-send-email.md)
