# BUG-030: `draft view`, `draft list`, `zmail send` hang after `draft edit` — Agent-Reported

**Status:** Closed — fix verified (2026-03-31). **Created:** 2026-03-31.

**Design lens:** [Agent-first](../../VISION.md) — The `draft → edit → view → send` loop is core outbound mail. Commands that hang with no output until SIGKILL block agents from verifying or sending drafts without falling back to raw file reads or manual user steps.

**Reported context:** Real workflow on macOS (Darwin 25.4.0), zmail 0.1.0, large mailbox (~26k messages). After successful `draft forward` and `draft edit`, subsequent draft-related commands entered a hang state for the rest of the session.

---

## Summary

After creating and editing a forward draft, **`zmail draft view`**, **`zmail draft list`**, and **`zmail send <draft-id>`** hang indefinitely: no stdout, no stderr, no error, until the process is killed (often exit **137** / SIGKILL). **`draft forward`** and **`draft edit`** completed successfully immediately before. Other commands (`search`, `read`, `refresh`, `who`) continued to work. The draft `.md` file on disk was intact and readable with `cat`.

---

## Root cause (confirmed)

**Unconditional SQLite open before draft work.** `main.rs` opened `db::open_file` for **every** `zmail draft …` subcommand and for **`zmail send <draft-id>`** before any draft file I/O. `draft list`, `draft view`, `draft edit`, and `rewrite` do **not** use the index; **`draft forward`**/`send` for a forward draft do not need the DB until threading (replies only). When another process holds the DB (e.g. background `zmail sync`), `open_file` blocks until `busy_timeout` — reported as **indefinite** hang when contention is severe or the lock is held for a long transaction.

---

## Resolution

1. **`zmail draft`:** Open SQLite only for **`draft reply`** and **`draft forward`** (`src/main.rs` + `run_draft(..., Option<&Connection>)` in `src/draft.rs`). List, view, new, edit, rewrite skip `open_file`.
2. **`zmail send <draft-id>`:** `send_draft_by_id` no longer takes `conn`; it opens the DB **inside** `send_draft_by_id` only when the draft `kind` is **reply** and threading headers must be loaded from the source message (`src/send/mod.rs`). Forward/new drafts send without opening SQLite.

**Verification:** Reporter confirmed the fix; draft list/view/send no longer hang after edit when the index is contended. Architectural follow-up: [ADR-026](../../ARCHITECTURE.md#adr-026-sqlite-concurrency--reads-vs-writes-lazy-open-avoiding-lock-contention).

---

## References

- Vision (agent-first): [VISION.md](../../VISION.md)
- Related: [BUG-027 archived](BUG-027-rust-draft-cli-errors-and-stdin-hang.md)
- Draft/send: [ADR-024](../../ARCHITECTURE.md#adr-024-outbound-email--smtp-send-as-user--local-drafts) in [ARCHITECTURE.md](../../ARCHITECTURE.md)
