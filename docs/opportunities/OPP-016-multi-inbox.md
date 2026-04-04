# OPP-016: Multi-Inbox — One Install, Many Mailboxes

**Status:** Opportunity.

**CLI note (2026-04):** Older drafts referred to **`zmail update`** — the shipped command is **`zmail refresh`** (fetch/backfill). Treat **`update`** as **`refresh`** if you see it in external notes.

## Context

zmail today is single-inbox: one IMAP identity, one config shape, one password. That is enough for one person and one address, but it breaks down when:

- Someone wants **personal and work** (or school and side project) in one agent workflow without juggling two installs or `ZMAIL_HOME` switches.
- An **operator or assistant stack** (e.g. **OpenClaw** or similar) needs **many distinct addresses** as first-class inboxes: `info@mycompany.com`, `support@mycompany.com`, `invoices@mycompany.com`, onboarding aliases, founder + shared mailboxes, etc. — **dozens** is a design target, not an edge case.

We want a **single installation** where:

- **Default path is simple:** sync and search see **all configured mailboxes** unless the user or config narrows scope.
- **Power path is explicit:** filter by **email address** (intuitive id), optional per-mailbox rules, optional “exclude from default search” for archival or low-priority boxes.
- **One place to reason about policy:** all non-secret mailbox settings live in **one root `config.json`** — no nested `config.json` per mailbox to drift or forget.

## Design principles

- **Scale in the dozens** — Config is a list, not a forest of files. Filesystem layout stays **flat**: no `accounts/` umbrella, no extra `data/` layer under each mailbox for the shared index. Per-mailbox dirs are **only** what must be physically separate: **secrets** and **that mailbox’s maildir**.
- **Dead-simple agent default** — **`zmail refresh`** runs over **all** mailboxes (respecting optional per-mailbox disable flags if we add them). **`zmail search`** (and MCP equivalents) hit **one** database; default scope is **all mailboxes included in search** (see below).
- **One unified SQLite DB** — `messages` (and related rows) carry a **`mailbox_id`** (stable string, typically derived from config). **`sync_state`** is keyed by **`(mailbox_id, folder)`** so two Gmail workspaces can both use `[Gmail]/All Mail` without collision. **No** fan-out across multiple DBs for global search — FTS ranking stays coherent.
- **Identify mailboxes by email in the CLI** — Humans and agents think in **`support@company.com`**. Resolve to **`mailbox_id`** / slug internally; accept email or slug where unambiguous.
- **Config vs secrets** — **No secrets in `config.json`.** Shared secrets (e.g. OpenAI) in **root `~/.zmail/.env`**; IMAP (and later SMTP) passwords in **per-mailbox `.env`** only.

## Proposed design

### Config: single root `config.json` (all mailboxes)

- **One file** at `ZMAIL_HOME/config.json` lists every mailbox and global knobs. **No** per-mailbox `config.json` — everything non-secret is here so diffs, reviews, and agent edits stay tractable with **many** entries.

```json
{
  "mailboxes": [
    {
      "id": "support_company_com",
      "email": "support@mycompany.com",
      "search": { "includeInDefault": true }
    },
    {
      "id": "invoices_company_com",
      "email": "invoices@mycompany.com",
      "imap": { "host": "imap.gmail.com", "port": 993 },
      "search": { "includeInDefault": true }
    },
    {
      "id": "archive_company_com",
      "email": "legacy@mycompany.com",
      "search": { "includeInDefault": false }
    }
  ],
  "sync": { "defaultSince": "1y", "excludeLabels": ["Trash", "Spam"] },
  "attachments": { "cacheExtractedText": false }
}
```

- **`id`** — Stable **`mailbox_id`** for schema, paths, and compact CLI. Required when email alone is ambiguous or filesystem-safe slugs are needed.
- **`email`** — Canonical IMAP user / From identity; primary human-facing identifier.
- **`search.includeInDefault`** — When `false`, **default** search (no mailbox filter) **omits** this mailbox; explicit `mailbox:` / `--mailbox` still includes it. Keeps “search everything I care about daily” clean when some boxes are huge or archival.
- Defaults (IMAP host/port, sync, attachments) apply globally; per-mailbox blocks override only what differs.

### `mailbox_id` and directory naming

- Prefer an explicit **`id`** in config (e.g. `support_company_com`) over encoding rules alone — **dozens** of addresses make reversible email→path schemes harder to eyeball. Document a **recommended** slug recipe (`@` → `_`, `.` → `_`) for new entries.
- Code resolves **`email` ↔ `id`** from the single config load; CLI accepts **either** where unique.

### Secrets: root `.env` + per-mailbox `.env`

- **`~/.zmail/.env`** — Shared only: e.g. `ZMAIL_OPENAI_API_KEY` / `OPENAI_API_KEY`. **No** per-mailbox IMAP passwords here (avoids `PASSWORD_WORK` explosion).
- **`~/.zmail/<id>/.env`** — That mailbox’s **`ZMAIL_IMAP_PASSWORD`** (same variable name everywhere; loader picks file by `mailbox_id`).

### Filesystem layout (flat)

Unified index at the home root; per-mailbox dirs hold **secrets + maildir** only (no second config file, no per-mailbox DB).

```text
~/.zmail/
  config.json           # all mailboxes + global settings (no secrets)
  rules.json            # global inbox rules (see below)
  zmail.db              # single SQLite (+ WAL/SHM alongside)
  .env                  # shared API keys only
  logs/                 # optional; sync logs, etc.
  <mailbox_id>/
    .env                # IMAP password for this mailbox
    maildir/            # this mailbox’s on-disk mail (rebuild/sync provenance)
    rules.json          # optional: per-mailbox rules (override/extension)
```

- **`zmail.db`** lives at **`ZMAIL_HOME/zmail.db`** (not under a redundant `data/` segment for the DB — optional `data/` subdir is an implementation detail if we keep compatibility with existing paths during migration).
- **`raw_path`** / maildir paths in SQLite are scoped under `<mailbox_id>/maildir/...` so ownership is obvious and rebuild walks the right tree.
- **Optional shared caches** (e.g. future vectors): either under `~/.zmail/cache/` or next to the DB — keyed by content with `mailbox_id` in app logic where needed.

This stays **flat** (no `accounts/` prefix), **one config file**, and scales to **many** sibling `<mailbox_id>/` directories without extra nesting.

### Inbox rules (global + optional per-mailbox)

- **`~/.zmail/rules.json`** — Default rule pack and patterns shared across mailboxes (OTP, generic bulk mail, etc.).
- **`~/.zmail/<mailbox_id>/rules.json`** — Optional **additions or overrides** for that mailbox (e.g. `support@` triage vs `invoices@` triage).
- **Evaluation order** should be **documented and fixed** (e.g. global rules first, then per-mailbox appended so mailbox-specific rules can win on first match — matches today’s “ordered list, first match wins” model).
- **`rules_fingerprint`** for inbox cache invalidation should reflect the **effective** rules for that mailbox (e.g. hash global + hash per-mailbox, or hash merged list).

### Sync / refresh

- **Default:** iterate **all** enabled mailboxes in `config.json`, load `<id>/.env`, sync into unified DB + `<id>/maildir/`.
- **Narrow:** `zmail refresh --mailbox support@mycompany.com` or `--mailbox support_company_com` for one box (debugging, rate limits, backfill).
- **Ordering:** config list order is a reasonable default; optional **`sync.priority`** (integer) later if some mailboxes should refresh first.

### Search, read, thread, MCP

- **Default search:** all mailboxes with **`search.includeInDefault !== false`** (missing = true). Single FTS query + `mailbox_id` filter in SQL when narrowing.
- **Explicit filter:** query operator **`mailbox:`** / **`inbox:`** (exact surface TBD) **or** CLI flag **`--mailbox <email|id>`** on commands that need scope.
- **JSON rows** should include **`mailboxId`** (and ideally **`email`**) so agents disambiguate when results mix many inboxes.
- **MCP tools** mirror CLI: optional mailbox parameter; default = same as CLI default search scope.

### `zmail status`

- With **many** mailboxes, status should stay readable: **one line per mailbox** (email, id, last sync, message count delta) in text mode; **`--json`** for agents (full list, structured errors per mailbox).
- Optional **summary line** at top: N configured, M healthy, last global refresh.

## Schema impact

- **`messages`:** add **`mailbox_id TEXT NOT NULL`** (backfill for legacy single-inbox rows).
- **`sync_state`:** composite key **`(mailbox_id, folder)`** (or encoded single key). Same idea for any folder-scoped sync tables.
- **Attachments / threads:** ensure foreign rows either carry **`mailbox_id`** or join through `messages` so cross-mailbox leaks are impossible.
- **FTS:** join to `messages` and filter on **`mailbox_id`** when the user narrows scope.
- **`message_id`:** consider composite uniqueness **`(mailbox_id, message_id)`** if the same provider Message-ID could theoretically appear twice across workspaces (defensive; Gmail-style global ids are usually fine).

## Backward compatibility

- **Legacy single-mailbox:** no `mailboxes` array — treat current **`imap.user`** + root **`ZMAIL_IMAP_PASSWORD`** as one implicit mailbox; **`mailbox_id`** default e.g. derived from email or a fixed `default`.
- **Existing paths:** today’s **`data/zmail.db`** + **`data/maildir/`** may migrate to **`zmail.db`** at home + **`{id}/maildir/`** (or keep `data/` as a compat shim during transition — implementation detail; early-dev installs can also wipe and resync per [AGENTS.md](../../AGENTS.md) clean-break norms).

## Open questions

- **DB path:** keep **`data/zmail.db`** for one release with a symlink or dual-read, vs cut straight to **`~/.zmail/zmail.db`**?
- **CLI flag name:** standardize on **`--mailbox`** (matches OPP-016 history) vs **`--account`** — pick one, alias the other if needed.
- **Default send mailbox** ([OPP-011](OPP-011-send-email.md)): explicit **`defaultSendMailbox`** in config vs first in list vs last-used.
- **Parallel refresh:** one writer on SQLite — serialize sync jobs vs pipeline per mailbox with explicit locking story ([ARCHITECTURE.md](../ARCHITECTURE.md) WAL notes).

## Summary

| Area | Choice |
|------|--------|
| **Scale** | Designed for **many** mailboxes (personal + work + role addresses + operators); one root config, flat dirs. |
| **DB** | **One** unified SQLite DB; **`mailbox_id`** on messages; **`sync_state`** keyed by mailbox + folder. |
| **Config** | **Single** `config.json` at `ZMAIL_HOME`; **no** per-mailbox config files; optional **`search.includeInDefault`**. |
| **Secrets** | Root `.env` (shared API keys); **`<mailbox_id>/.env`** (IMAP password per mailbox). |
| **Layout** | **`zmail.db`** at home root; **`<mailbox_id>/.env`** + **`<mailbox_id>/maildir/`**; optional **`<mailbox_id>/rules.json`**. |
| **Rules** | Global **`rules.json`** + optional per-mailbox rules; **composite fingerprint** for inbox cache. |
| **Sync** | Default: **all** mailboxes; optional **`--mailbox`** to narrow. |
| **Query / CLI** | Default search = all **included** mailboxes; filter by **email or id**; JSON exposes mailbox fields. |
| **Status** | Per-mailbox lines + **JSON** for large sets. |
