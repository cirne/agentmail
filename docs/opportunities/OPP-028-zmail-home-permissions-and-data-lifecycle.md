# OPP-028: Zmail home permissions — secure defaults and data lifecycle

**Status:** Opportunity.

## Context

zmail stores configuration and secrets under `ZMAIL_HOME` (default `~/.zmail`): `config.json`, `.env` (IMAP password, OpenAI key), SQLite under `data/`, maildir, drafts, logs, attachment caches, etc.

Today the codebase does **not** set explicit file or directory modes: it relies on Node’s defaults (`mkdirSync` / `writeFileSync` without `mode`) and the process **umask**. On typical Unix systems with `umask 022`, new directories are often `0755` and new files `0644` — so `.env` and other sensitive files can be **world-readable** if another local user can reach the path (e.g. shared multi-user host, loose home-directory permissions). This is a known class of issue, not zmail-specific, but we do not document or harden it.

This opp captures a possible **future enhancement**: tighter defaults, optional verification, and clear docs — without making normal **wipe / reset / delete stale data** workflows painful.

## Goals

- Reduce accidental exposure of secrets and mail data to **other Unix users** on the same machine (non-root).
- Keep **first-class** support for “delete everything and start over” and “drop large cached trees” (aligned with [AGENTS.md](../../AGENTS.md) no-migrations / reset-from-disk philosophy).
- Document tradeoffs if we ever mark data **immutable** or **read-only** at the OS level.

## Proposed directions (non-exclusive)

### A) Set explicit modes in code (preferred if we implement)

- On `mkdirSync` for paths under `ZMAIL_HOME`, pass `mode: 0o700` (or `0o750` if a documented group-sharing story appears later).
- On writes of secrets (`.env`) and optionally `config.json`, use `mode: 0o600`.
- Optionally `chmod` existing files once at startup or in `setup`/`wizard` if we detect loose permissions (idempotent “heal” step).

**Implementation note:** Node applies `mode & ~umask` on POSIX; document that umask can still narrow permissions, but explicit modes make intent obvious and tests can assert behavior where feasible.

### B) Document manual hardening (minimal)

- User-run: `chmod 700 ~/.zmail` and `chmod 600 ~/.zmail/.env` (and tighten DB if desired).
- Link from skill / setup docs for multi-user or SSH-server scenarios.

### C) Optional `zmail doctor` (or setup check)

- Warn if `.env` or the DB is group- or world-readable, or if `ZMAIL_HOME` is too loose.
- No silent auto-chmod unless we explicitly opt in (could surprise scripts).

## Read-only / “immutable” data vs easy deletion

**Distinction that matters:**

| Mechanism | Effect on “protect from other users” | Effect on owner delete / `rm -rf` |
|-----------|--------------------------------------|-----------------------------------|
| **Tighter Unix modes** (e.g. `700` home, `600` secrets) | Stronger vs other UIDs | **No meaningful friction** for the owning user removing trees under home |
| **Read-only file bit** (`chmod a-w` / `0444`) | Little vs other users; mainly accident guardrails | **Still easy for owner to delete**: unlink is controlled by **directory** write permission, not the file’s write bit; `rm` / `rm -rf` works as usual for the owner |
| **Immutable / append-only flags** (e.g. macOS `uchg` / `schg`, Linux `chattr +i`) | Can prevent tampering | **Can block deletion and renames** until flags are cleared — bad fit for “wipe cache” or “reset data dir” unless we document a clear **unlock** path |

So: **defaulting to `0600` for secrets and `0700` for private dirs does not conflict with wiping data.** It may even align with “only my user can delete under `~/.zmail`” on some setups.

If we ever **flag many files read-only** (e.g. “cached inbox artifacts must not be mutated”):

- **POSIX read-only files** are still removable by the owner in normal layouts; complexity stays low.
- **OS-level immutability** would make bulk removal harder and would require a deliberate **strip flags** step (or a `zmail` subcommand) before `rm -rf` — that is a product decision: security vs operational simplicity.

Recommendation for this opp: prefer **permissions + ownership** for confidentiality; avoid immutable flags for hot paths unless we add an explicit **maintenance / wipe** story.

## Wipe and reset (must stay simple)

Users and agents already rely on patterns like removing `~/.zmail/data` or the whole `ZMAIL_HOME` and re-running setup/sync. Any permission work should:

- **Not** introduce mandatory root-only cleanup.
- **Not** require chasing thousands of `chflags`/`chattr` clears unless we document a single **`zmail … reset`** (or similar) that clears flags then deletes.

Optional doc snippet (future): “To remove all local zmail state: …” listing `rm -rf` on `ZMAIL_HOME` or `data/` only, consistent with existing agent guidance.

## Acceptance / done criteria (if implemented)

- [ ] Documented default permission behavior and recommended manual hardening (or code-set modes).
- [ ] If code-set: secrets and private dirs created with restrictive modes; tests or smoke checks where practical.
- [ ] Explicit note on readonly vs immutable vs user wipe (`rm -rf`, full home delete).
- [ ] No regression for “delete `data/` and resync” workflows.

## References

- Internal discussion: zmail currently uses default Node `mkdir`/`writeFile` modes (umask-driven).
- [AGENTS.md](../../AGENTS.md) — data location, no migrations, reset patterns.
