# Merge review: experiment/opp-020-answer-engine → main

**Branch:** `experiment/opp-020-answer-engine`  
**Scope:** `zmail ask` command (answer engine), schema/sync/refresh/search changes, eval suite.  
**Review date:** 2026-03-09

---

## Summary

The branch is **ready to merge** after the fixes applied below. It adds a significant feature (`zmail ask`) plus related improvements (noise signal, refresh UX, schema lifecycle, eval suite).

---

## Scope of changes (vs main)

| Area | Change |
|------|--------|
| **CLI** | New `zmail ask "<question>"`; search `--include-noise`; refresh `--force` / `--include-noise` / `--text` and new-mail preview; sync positional `duration`; schema check moved to entrypoint. |
| **Ask pipeline** | New `src/ask/`: agent (Nano → context assembler → Mini), tools, unit tests, eval suite (`npm run eval`). |
| **Search** | `includeNoise` option; filter compiler supports noise filtering. |
| **DB** | `messages.is_noise`, `SCHEMA_VERSION = 4`; `ensureSchemaUpToDate()` (async schema rebuild from maildir); schema check before any DB-using command. |
| **Sync** | `is_noise` from headers (List-*, Precedence, X-Auto-Response-Suppress); `force` and `earlyExit`; `newMessageIds` for refresh preview; backward UID filtering (resume vs expand). |
| **Docs** | `docs/ASK.md`, `docs/ASK-TESTING.md`, OPP-020/OPP-021, BUG-019, algorithm review, phase2 comparison/summary. |
| **Test** | Eval tests excluded from `npm test`; run via `npm run eval`; vitest.eval.config.ts. |

---

## Checks performed

- **Lint:** `npm run lint` (tsc --noEmit) passes.
- **Tests:** `npm test` — 31 files, 364 passed, 7 skipped (ask agent tests skipped for two-phase arch). Eval suite not run (requires `ZMAIL_OPENAI_API_KEY`).
- **Diff:** Reviewed CLI entrypoints, ask module, search/db/sync changes, package/vitest.
- **Docs:** AGENTS.md, ASK.md, MCP.md, ARCHITECTURE.md referenced where relevant.

---

## Fixes applied during review

1. **`src/index.ts`** — Fixed brace/indent: `} else {` and the following block were mis-indented (else at 2 spaces). Aligned to match `if (!command)` so control flow is clear.
2. **`src/ask/agent.ts`** — Removed duplicate JSDoc above `shouldIncludeAttachments`.
3. **`vitest.config.ts`** — Excluded `dist/**` so only source tests run. Avoids dist tests resolving `dist/index.ts` and pulling in stale deps (e.g. LanceDB).
4. **`package.json`** — Removed unused `@lancedb/lancedb-linux-arm64-gnu`. No source uses it; it was causing failures when vitest ran compiled tests from dist.

---

## Pre-merge checklist

- [x] Lint passes
- [x] `npm test` passes (source tests only)
- [x] Obvious code/style issues fixed
- [ ] Optional: run `npm run eval` with `ZMAIL_OPENAI_API_KEY` to confirm eval suite
- [ ] Optional: run `npm run build` and smoke-test `dist/index.js` (e.g. `node dist/index.js --help`)

---

## Notes for after merge

- **Schema:** Existing users with DBs from schema version &lt; 4 will get an automatic rebuild from maildir on first run (stderr message + up to ~20s). No migrations; AGENTS.md already documents this.
- **Ask:** Documented in `docs/ASK.md` and AGENTS.md. Requires `ZMAIL_OPENAI_API_KEY` (or `zmail setup --openai-key`).
- **Eval:** `npm run eval` runs LLM-as-judge evals; separate from `npm test`. See `src/ask/EVAL_README.md`.
- **Skipped tests:** `src/ask/agent.test.ts` has 7 tests skipped (TODOs for two-phase architecture). Consider re-enabling and updating mocks in a follow-up.

---

## File count (diff stat)

38 files changed, ~5047 insertions, ~646 deletions (including docs and tests).
