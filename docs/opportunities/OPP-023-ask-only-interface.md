# OPP-023: Ask-Only Interface — Remove Search/Read/Thread/Who Primitives from CLI and MCP

**Status:** Proposed. **Created:** 2026-03-09.

**Problem:** zmail exposes two tiers of interface: primitives (search, read, thread, who, attachment) and the answer engine (`ask`). Primitives are slower (3-4 rounds × 15-25s = 60-100s), more expensive (~$0.10-0.20/query vs ~$0.003-0.01), harder to use correctly (agents must learn 6+ commands with different flags), and more bug-prone (BUG-021: `read` crashes while `ask` works fine). The answer engine delivers 5-10x faster, cheaper answers by design. Maintaining both interfaces doubles the surface area without doubling value.

**Proposed direction:** Remove `search`, `read`, `thread`, `who`, and `attachment` from both CLI and MCP. Make `ask` the sole query interface. Keep infrastructure commands (`sync`, `refresh`, `status`, `stats`, `setup`, `wizard`, `mcp`). The internal search/read/who functions remain as library code — `ask` calls them internally — but they are no longer exposed to users or agents.

---

## Why now

1. **`ask` already works and is strictly better for agents.** OPP-020 validated the architecture: 5-10x faster, 10-20x cheaper, zero orchestration overhead. Every improvement we make to `ask` (OPP-022 detail level, OPP-021 noise filtering) compounds. Primitives are the slow path that agents shouldn't take.

2. **Primitives are the primary source of bugs.** BUG-021 (`read` crashes with prepare error) exists because `read` has a different DB code path than `ask`. BUG-018 (`who --timings` unknown flag) is a flag inconsistency across commands. Every primitive is a surface to maintain, test, and debug. Removing them eliminates entire categories of bugs.

3. **Surface area costs are real.** Six commands × flags × output formats × JSON/text modes × MCP tool schemas × documentation × help text × tests. For a solo developer, this is significant ongoing maintenance. The marginal value of primitives over `ask` doesn't justify the cost.

4. **Forcing function for `ask` quality.** As long as primitives exist, `ask` can coast — agents can fall back to `search` + `read` when `ask` is insufficient. Removing the escape hatch forces us to make `ask` great for every use case (OPP-022).

---

## What gets removed

### CLI commands removed

| Command | Lines (approx) | Replacement via `ask` |
|---------|----------------|----------------------|
| `zmail search <query>` | ~130 lines | `zmail ask "find emails about X"` |
| `zmail read <message_id>` | ~25 lines | `zmail ask "what does the email from X about Y say?"` |
| `zmail thread <thread_id>` | ~70 lines | `zmail ask "summarize the thread about X"` |
| `zmail who <query>` | ~85 lines | `zmail ask "who is X?"` |
| `zmail attachment list <id>` | ~55 lines | `zmail ask "what attachments are in the email about X?"` |
| `zmail attachment read <id> <file>` | ~110 lines | `zmail ask "what's in the spreadsheet from X?"` |

### MCP tools removed

| Tool | Replacement |
|------|------------|
| `search_mail` | `ask_email` (new MCP tool wrapping `ask`) |
| `get_message` | `ask_email` |
| `get_messages` | `ask_email` |
| `get_thread` | `ask_email` |
| `who` | `ask_email` |
| `list_attachments` | `ask_email` |
| `read_attachment` | `ask_email` |

### What stays

| Command/Tool | Why |
|-------------|-----|
| `zmail ask` / MCP `ask_email` | The primary query interface |
| `zmail sync` | Data ingestion — not a query |
| `zmail refresh` | Data ingestion — not a query |
| `zmail status` / MCP `get_status` | Operational — not a query |
| `zmail stats` / MCP `get_stats` | Operational — not a query |
| `zmail setup` / `zmail wizard` | Onboarding — not a query |
| `zmail mcp` | Server entrypoint |

### Internal code stays (library, not exposed)

The search, read, who, attachment functions in `src/search/`, `src/messages/`, `src/attachments/` remain as internal library code. `ask`'s investigation phase (nano) calls these internally. They just aren't exposed as CLI commands or MCP tools.

---

## Tradeoffs

### What we gain

- **Radically simpler interface.** One query command: `ask`. One MCP tool: `ask_email`. Agents don't need to learn search syntax, message ID formats, thread ID conventions, flag combinations, or output mode switching.
- **Fewer bugs.** Every removed command is a code path we no longer maintain. BUG-021 ceases to exist. Flag inconsistencies (BUG-018) disappear.
- **Faster iteration on what matters.** All query-interface effort goes into making `ask` better instead of splitting across 6 commands.
- **Cleaner mental model.** "Got a question about your email? `zmail ask`." No decision tree.
- **CLI and MCP stay in sync.** Both have the same interface: `ask` for queries, infrastructure commands for operations.

### What we lose (and mitigations)

| Loss | Severity | Mitigation |
|------|----------|------------|
| **Structured JSON output** — agents can't get a JSON array of search results to render in a UI or process programmatically | Medium | Phase 2: add structured output mode to `ask` (e.g. `--json` returns `{ answer, sources: [...], messages: [...] }`). Or keep `search` as a hidden/internal debug command. |
| **Offline/no-API-key usage** — primitives work without OpenAI; `ask` requires `ZMAIL_OPENAI_API_KEY` | Medium | Prerequisite: solve before removing primitives. Options: (a) require API key for all query features (acceptable for agent-first product), (b) local model fallback (OPP-002), (c) keep a minimal `search --offline` escape hatch. |
| **Debugging opaqueness** — can't `search` then `read` to verify what `ask` sees | Low | `ask --verbose` already shows the full pipeline (searches run, messages fetched, context assembled). Enhance verbose output if needed. |
| **Raw data access** — `attachment read --raw` for binary extraction, `read --raw` for EML | Low | These are rare power-user operations. Could keep as hidden/undocumented commands or add `ask --raw-attachment <id>` if needed. |
| **`who` as structured contact lookup** — returns JSON with addresses, phone, title, counts | Low | `ask "who is X?"` returns the same info as prose. If structured contact data is needed later (OPP-012, OPP-015), expose a dedicated `contacts` command rather than the current `who`. |

### Key risk: API key dependency

The most significant tradeoff is that removing primitives makes zmail entirely dependent on an OpenAI API key for any query functionality. Today, a user can `zmail search` and `zmail read` without any API key. After this change, `zmail ask` is the only query path and it requires `ZMAIL_OPENAI_API_KEY`.

**Assessment:** For an agent-first product where the primary consumer is an LLM (which itself costs money to run), requiring a cheap API key ($0.003/query) is acceptable. Users who install zmail already have API keys. If this becomes a barrier, local models (OPP-002) or a future free tier could address it.

---

## Implementation plan

### Phase 1: Add `ask_email` MCP tool

Before removing anything, add `ask` as an MCP tool so MCP consumers have the replacement ready.

- Add `ask_email` tool to `src/mcp/index.ts` wrapping `runAsk()`
- Schema: `{ question: string }` → `{ answer: string, pipelineMs: number }`
- Test alongside existing tools

### Phase 2: Deprecate primitives (soft removal)

- Remove `search`, `read`, `thread`, `who`, `attachment` from `--help` output and docs
- Keep the commands functional but print a deprecation notice: `"Deprecated: use 'zmail ask' instead."`
- Remove primitive MCP tools from tool listing (but keep them functional for one release)
- Update AGENTS.md, README, ASK.md to reflect `ask`-only interface
- Update MCP.md to show `ask_email` as the primary tool

### Phase 3: Hard removal

- Remove CLI command handlers for `search`, `read`, `thread`, `who`, `attachment`
- Remove MCP tool definitions for `search_mail`, `get_message`, `get_messages`, `get_thread`, `who`, `list_attachments`, `read_attachment`
- Remove associated test code
- Keep internal library functions (used by `ask`)
- Clean up imports, dead code

### Prerequisites (before Phase 2)

- **OPP-022** (ask detail level) — `ask` must produce thorough answers for synthesis queries
- **BUG-021** (read prepare error) — moot after removal, but fix anyway since `ask` uses the same internal functions
- **`ask_email` MCP tool** — must exist before removing MCP primitives
- **Decision on API key requirement** — confirm that requiring `ZMAIL_OPENAI_API_KEY` for all queries is acceptable

---

## Relationship to other work

| Item | Impact |
|------|--------|
| **OPP-020** (answer engine) | This is the natural conclusion of OPP-020. OPP-020 said "make `ask` the primary interface." OPP-023 says "make it the only interface." |
| **OPP-022** (ask detail level) | Must ship first. If `ask` is the only interface, it must handle every query well. |
| **OPP-021** (noise awareness) | Applies to `ask` only after this change — no search primitive to separately filter. |
| **OPP-018** (reduce round-trips) | **Archived** (phase 1 delivered). Partially superseded for external orchestration: [archive/OPP-018-reduce-agent-round-trips.md](archive/OPP-018-reduce-agent-round-trips.md). With `ask` as the only tool, the outer agent makes one call — internal pipeline improvements (body preview, batch reads, slim search) still help `ask` internally. |
| **OPP-012, OPP-013, OPP-015** (who/contacts) | `who` as a primitive goes away. Contact features would be exposed through `ask` ("who is X?") or a future dedicated `contacts` command. |
| **BUG-017** (semantic recall gap) | Resolved by FTS-first + `ask`'s internal agent loop. No primitive to mis-use. |
| **BUG-018** (`who --timings`) | Eliminated — `who` command no longer exists. |
| **BUG-021** (read prepare error) | Eliminated — `read` command no longer exists. |

---

## What success looks like

- **CLI surface:** `zmail ask`, `zmail sync`, `zmail refresh`, `zmail status`, `zmail stats`, `zmail setup`, `zmail wizard`, `zmail mcp`. That's it.
- **MCP surface:** `ask_email`, `get_status`, `get_stats`. Three tools.
- **Agent experience:** One tool call answers any email question. No multi-step orchestration, no flag guessing, no ID format confusion.
- **Maintenance:** ~50% less CLI code, ~70% fewer MCP tool definitions, proportionally fewer tests and docs.

---

## References

- Answer engine architecture: [OPP-020](OPP-020-answer-engine-local-agent.md)
- Ask detail level: [OPP-022](OPP-022-ask-synthesis-detail-level.md)
- Ask documentation: [docs/ASK.md](../ASK.md)
- MCP current tools: [docs/MCP.md](../MCP.md)
- Read bug (illustrates primitive maintenance cost): [BUG-021](../bugs/BUG-021-read-prepare-error.md)
- Reduce round-trips (archived; partially superseded for outer agent): [OPP-018](archive/OPP-018-reduce-agent-round-trips.md)
