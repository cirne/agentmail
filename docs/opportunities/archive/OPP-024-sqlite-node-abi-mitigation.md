# OPP-024: SQLite / Node ABI — Global Install Reliability

**Status:** Implemented (archived 2026-03-20)

## Problem

`better-sqlite3` ships a **native addon** (`.node`) tied to Node’s **`NODE_MODULE_VERSION`**. After `npm install -g @cirne/zmail`, users often hit:

- `ERR_DLOPEN_FAILED`
- “was compiled against a different Node.js version using NODE_MODULE_VERSION …”

when the addon was built or prebuilt for a different Node than the one running `zmail`.

## Direction (implemented)

1. **`package.json` `postinstall`** — runs `npm rebuild better-sqlite3` for the **current** Node when `node_modules` exists, so the addon matches the installing runtime in the common case.
2. **Async `SqliteDatabase` facade** — narrow interface (`exec`, `prepare` → async `run` / `get` / `all`, `close`) implemented by `src/db/better-sqlite-adapter.ts` around `better-sqlite3`. Call sites use `await` consistently (CLI, sync, search, MCP, ask).
3. **Documentation** — [ADR-023](../../ARCHITECTURE.md) in `docs/ARCHITECTURE.md`; install / fallback notes in [AGENTS.md](../../AGENTS.md).
4. **Schema / data** — On schema or packaging changes that invalidate the DB: bump `SCHEMA_VERSION`, delete DB + WAL sidecars, **rebuild from maildir** (no row migration). Same as [ADR-021](../../ARCHITECTURE.md).

## Explicit non-goals (unchanged product constraints)

- **No whole-database-in-RAM** persistence for production (e.g. naive sql.js load/export for multi-hundred-GB stores). Keep **file-backed** SQLite via the native binding.
- **No requirement** to read legacy DB bytes with a different driver; wipe and rebuild from raw email is acceptable.

## Fallback for users

If load still fails: run **`npm rebuild better-sqlite3`** using the **same** `node` binary that executes `zmail`, or reinstall after aligning Node versions.

## See also

- [ADR-023: SQLite access — file-backed native + async facade + install-time rebuild](../../ARCHITECTURE.md#adr-023-sqlite-access--file-backed-native--async-facade--install-time-rebuild)
