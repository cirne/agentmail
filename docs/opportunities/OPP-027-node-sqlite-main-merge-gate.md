# OPP-027: `node:sqlite` vs `main` — ExperimentalWarning merge gate

**Status:** Active policy. **Do not merge** the `node:sqlite` migration to **`main`** until the gate below is cleared (or the project explicitly accepts the tradeoff).

## Problem

Node’s built-in **`node:sqlite`** avoids native-addon **ABI** issues (`better-sqlite3` + `NODE_MODULE_VERSION` mismatches after `npm install -g`, etc.). That is a real win for global CLI installs.

However, loading `node:sqlite` causes Node to emit an **`ExperimentalWarning`** on stderr (SQLite is still marked experimental in current Node releases). For a CLI that agents and humans run constantly, **printing that warning on every invocation is a product deal-breaker** — noise, confusion, and “is this broken?” friction outweigh the ABI benefits **for shipping on `main` today**.

Suppressing the warning in-process (`process.emitWarning`) or via flags was considered **too hacky** to maintain; living with the spam was also rejected for `main`.

## Decision

- **`main` stays on `better-sqlite3`** (native addon) and the documented **ABI mitigations** (see archived [OPP-024](../archive/OPP-024-sqlite-node-abi-mitigation.md) — `postinstall` / rebuild guidance, async `SqliteDatabase` facade pattern). **ABI warts are acceptable** relative to experimental-warning UX for end users.
- **Branches / experiments** using `node:sqlite` (see [ADR-023](../ARCHITECTURE.md) adapter notes) are **not ready to merge to `main`** until one of:
  - Node **stabilizes** `node:sqlite` and **stops emitting** this warning for normal use, or
  - The team **explicitly accepts** the warning (or another officially supported suppression story), documented in this file and ADR-023.

## Revisit triggers

- Node release notes: `node:sqlite` no longer experimental, or warning removed.
- Product decision: experimental warning is acceptable for the CLI audience.

## References

- [ADR-023: SQLite access](../ARCHITECTURE.md) (`node:sqlite` + async facade — may reflect branch work; **`main` driver policy is here**).
- [OPP-024 archive](../archive/OPP-024-sqlite-node-abi-mitigation.md) — `better-sqlite3` + global install / ABI mitigations (the path **`main` follows** until OPP-027 is cleared).
