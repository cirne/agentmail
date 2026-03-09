# OPP-017: Code Health Sprint — Simplify, Reuse, and Idiomatic Patterns

**Status:** Opportunity.

## Context

Recent code review across CLI, sync/indexing, search, MCP, config, and scripts found several high-leverage opportunities to simplify core flows, reduce duplication, and align with idiomatic TypeScript/Node patterns. None of these require product-surface changes; they are code health investments that reduce regression risk and speed up feature work.

## Goals

- Reduce coupling and duplicated logic in core runtime paths.
- Make lifecycle and failure behavior explicit and testable.
- Improve layering boundaries (CLI vs MCP vs core services).
- Keep behavior stable while improving maintainability.

## Top opportunities (prioritized)

### 1) Make process locking atomic and owner-safe (High)

Current lock acquisition uses separate read/write steps, which can race under contention.

- **Current:** `SELECT is_running` then unconditional `UPDATE ... is_running = 1`.
- **Risk:** Two processes can both acquire lock in edge cases; lock release is not owner-guarded.
- **Opportunity:** Use transactional compare-and-set semantics:
  - `BEGIN IMMEDIATE`
  - guarded update (`... WHERE id = 1 AND is_running = 0`)
  - stale-lock takeover and ownership checks in the same transaction
  - owner-aware release (`WHERE owner_pid = ?`)

### 2) Extract reusable sync+index orchestration and fix completion signaling (High)

`sync` and `refresh` duplicate orchestration logic and rely on a success-only signal to notify indexing completion.

- **Current:** `resolveSyncDone()` only runs on the success path of `runSync(...).then(...)`.
- **Risk:** On sync failure, indexing completion signal may never fire; duplicated code drifts.
- **Opportunity:** Introduce shared pipeline helper (`runSyncAndIndex`) that:
  - resolves completion in `finally`
  - centralizes metrics/output mapping
  - is reused by both `sync --foreground` and `refresh`

### 3) Refactor CLI from monolithic router to command modules (Medium-High)

`src/cli/index.ts` currently combines parsing, business logic, formatting, and command dispatch in one large file.

- **Current:** one large switch-based command router.
- **Risk:** high change blast radius, weak test targeting, repeated parsing/help logic.
- **Opportunity:** split into:
  - `commands/*` handlers (one module per command family)
  - shared parsing/flag helpers
  - thin dispatcher registry (`Record<Command, Handler>`)

### 4) Remove import-time config side effects and cached snapshots (Medium-High)

Config and `.env` loading happen at module import, with a partially cached snapshot.

- **Current:** import mutates `process.env`; `configJson` is loaded once.
- **Risk:** hidden global state and stale values in tests and long-running processes.
- **Opportunity:** move to explicit config API:
  - `loadConfig({ home, env })` as pure function
  - optional memoization with explicit invalidation
  - keep `process.env` mutation at process boundary only

### 5) Share ingestion primitives across sync/rebuild and clarify thread semantics (Medium)

Sync and rebuild duplicate message persistence logic; `thread_id` currently mirrors `message_id`.

- **Current:** parallel insert logic in `sync` and `rebuild`; pseudo-thread rows (`message_count=1`).
- **Risk:** drift between ingestion paths and misleading “thread” behavior in APIs.
- **Opportunity:**
  - extract shared persistence helpers (`persistMessage`, `persistAttachments`)
  - decide on thread model explicitly:
    - either real conversation grouping (provider/ref-based), or
    - temporary single-message conversation semantics with clear naming/docs

### 6) Restore clean layering between MCP and CLI (Medium)

MCP tools import CLI formatting helpers from the CLI entry module.

- **Current:** MCP depends on CLI module internals.
- **Risk:** boundary inversion, accidental side effects, tighter coupling.
- **Opportunity:** move shaping/formatting into a neutral shared presenter module used by both MCP and CLI.

### 7) Consolidate query filter compilation and semantics (Medium)

Search filtering logic is duplicated across code paths and `filterOr` behavior differs by mode.

- **Current:** multiple filter builders in filter-only/FTS/vector flows.
- **Risk:** subtle behavioral inconsistencies and harder bug fixes.
- **Opportunity:** introduce single filter compiler and shared semantics contract with parity tests.

### 8) Harden script layer and centralize shell helpers (Low-Medium)

Scripts duplicate helper functions and rely on brittle text matching for structured files.

- **Current:** repeated color/log helpers; fragile `grep` checks; publish mutates version early.
- **Risk:** script drift and partial-failure cleanup pain.
- **Opportunity:** add `scripts/lib/common.sh`, use structured parsing where possible, and add rollback trap in publish flow.

## Suggested execution plan

1. **Safety first:** lock atomicity + sync/index lifecycle signaling.
2. **Boundary cleanup:** MCP/CLI presenter extraction + config loading refactor.
3. **Reuse pass:** sync/rebuild shared ingestion + search filter compiler.
4. **Surface cleanup:** CLI modularization + script hardening.

## Success criteria

- No behavior regressions in CLI output contracts.
- Lock contention tests pass with deterministic winner.
- Sync/index completion is guaranteed on success and failure paths.
- MCP no longer imports CLI entry modules.
- Search filter behavior is consistent across filter-only/FTS/hybrid paths.
