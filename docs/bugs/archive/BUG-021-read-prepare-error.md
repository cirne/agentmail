# BUG-021: `zmail read` and MCP `get_messages` Fail with Database Prepare Error — Agent-Reported

**Status:** Fixed (2026-03-09). All call sites now pass `db` explicitly to `formatMessageForOutput` instead of relying on the internal `getDb()` fallback.

**Design lens:** [Agent-first](../../VISION.md) — `read` is a core primitive in the search→read→synthesize workflow. When it fails, agents cannot access email bodies at all, falling back to `zmail ask` (which uses a different code path).

**Reported context:** Agent session 2026-03-09, macOS Darwin 25.2.0. 488 emails indexed (2026-02-27 to 2026-03-06). Reproducible with every message ID tested.

---

## Summary

Both `zmail read <message_id>` and the MCP `get_messages` tool fail with:

```
Cannot read properties of undefined (reading 'prepare')
```

This completely blocks the search→read→synthesize workflow. The agent cannot read any individual email body via `read` or `get_messages`. The only workaround is `zmail ask`, which works because it uses a different code path to access message content (direct SQL in `assembleContext` via `src/ask/agent.ts`).

---

## What the agent did (and what happened)

1. Searched for emails: `zmail search "from:kirsten glamping"` — returned message IDs with body previews (works fine)
2. Attempted to read a message: `zmail read "<DFA2CF50-9F2B-4B71-A85A-3E02C85233C2@mac.com>"` — failed
3. Attempted via MCP: `get_messages(messageIds: ["<DFA2CF50-9F2B-4B71-A85A-3E02C85233C2@mac.com>"])` — same error
4. Tested with multiple message IDs — all fail identically
5. Fell back to `zmail ask` which successfully read and synthesized from the same emails

---

## Root causes

The `prepare` error (`Cannot read properties of undefined (reading 'prepare')`) indicates that a database handle or statement object is `undefined` at the call site. Likely causes:

1. **DB not passed or initialized** — The `read` / `get_messages` code path may not be receiving the database instance, or it may be using a different initialization path than `search` and `ask`.
2. **Code path divergence** — `zmail ask` accesses messages via `db.prepare(...)` directly in `assembleContext()` (in `src/ask/agent.ts`), while `read` likely goes through `formatMessageForOutput()` in `src/messages/presenter.ts`. The presenter may expect a DB reference that isn't provided or is stale.
3. **Recent refactoring** — The git status shows uncommitted changes in `src/messages/presenter.ts`, `src/ask/agent.ts`, and `src/ask/tools.ts`. The presenter change may have introduced a dependency on a DB parameter that the `read` command's call site doesn't provide.

---

## Recommendations (concise)

1. **Trace the call chain** for `zmail read` → `presenter.ts` → DB access. Verify the DB handle is passed through at every level.
2. **Compare with `ask`'s working path** — `ask` accesses messages via `db.prepare(...)` in `assembleContext()`. The `read` path should use the same DB instance.
3. **Check `src/messages/presenter.ts` changes** — the uncommitted diff may show where the DB reference was introduced or broken.
4. **Add a guard** — if `db` is undefined at the `prepare` call site, throw a clear error ("Database not initialized") rather than a generic TypeError.

---

## Impact

- **P0** — Blocks the primary agent workflow (search → read → synthesize)
- Agent cannot read any email body via CLI or MCP
- Only workaround is `zmail ask`, which handles orchestration internally
- Affects both CLI users and MCP-integrated agents

---

## References

- Vision (agent-first): [VISION.md](../../VISION.md)
- Message presenter: `src/messages/presenter.ts` (likely location of the bug)
- Ask's working path: `src/ask/agent.ts` (`assembleContext()` — line ~97)
- MCP get_messages: `src/mcp/index.ts`
- CLI read command: `src/cli/index.ts`
