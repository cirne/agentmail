# OPP-016: Multi-Inbox — One Install, Home + Work

**Status:** Opportunity.

## Context

zmail today is single-inbox: one IMAP identity, one config, one password. Users who want both personal and work email in the same agent experience have to run two installs or switch configs. We want a single installation to support multiple inboxes (e.g. home and work) with a dead-simple agent interface: the user does not manage or think about which mailbox is which; sync and search just work across all of them.

## Design principles

- **Dead simple agent interface** — User does not worry about managing or syncing multiple mailboxes. Sync/refresh by default operate on **all** mailboxes; optional flags can narrow scope for sync operations (e.g. `zmail sync --mailbox work` for debugging or one-off backfill).
- **One unified SQLite DB** — One index for all mail. Search, who, thread, read, and MCP tools hit a single database with a mailbox/account identifier on each row. No “which DB” or aggregating across DBs; one `zmail search` sees everything. This drives schema (e.g. `messages.mailbox_id`, `sync_state` keyed by mailbox + folder) and data layout (one `data/` tree).
- **Config vs secrets** — Config (non-secret) lives in one place; secrets live in .env files. No secrets in config.json.

## Proposed design

### Config: single hierarchical config.json

- **One `config.json`** at ZMAIL_HOME with config (no secrets) for all mailboxes. JSON is already hierarchical; e.g. a list of mailboxes with per-mailbox overrides:

```json
{
  "mailboxes": [
    { "email": "me@gmail.com" },
    { "email": "me@company.com", "imap": { "host": "imap.company.com", "port": 993 } }
  ],
  "sync": { "defaultSince": "1y", "excludeLabels": ["trash", "spam"] },
  "attachments": { "cacheExtractedText": false }
}
```

- Defaults (IMAP host/port, sync settings) apply to all; per-mailbox only what’s needed (e.g. work IMAP host). No passwords or API keys in config.

### Mailbox ID from email

- Map email to a stable subdirectory name with a straightforward, reversible convention: replace `@` with a character (e.g. `_at_` or `-`), and optionally replace `.` (e.g. `me_gmail_com`, `me_company_com`). Ensures one dir per mailbox and no filesystem collisions. Exact mapping TBD (e.g. `@` → `_at_`, `.` → `_`).

### Secrets: root .env + per-mailbox .env

- **Root `.env`** (`~/.zmail/.env`) — shared variables only, e.g. `OPENAI_API_KEY`. No per-mailbox secrets here so one key serves all accounts.
- **Per-mailbox `.env`** — each mailbox has a subdir under ZMAIL_HOME named by the mailbox id (e.g. `~/.zmail/me_gmail_com/.env`). That file holds that mailbox’s IMAP password (e.g. `ZMAIL_IMAP_PASSWORD=...`). Same variable name in every mailbox .env; the loader knows which file to read based on which mailbox is being used. No flat env proliferation (no `ZMAIL_IMAP_PASSWORD_WORK` etc.).

### Data layout (unified DB)

Because we use **one unified SQLite DB**, there is a single data tree:

- **`~/.zmail/data/`** — the only data dir:
  - `data/zmail.db` — single SQLite DB; `messages` (and any other per-message tables) have a `mailbox_id` column; `sync_state` is keyed by `(mailbox_id, folder)` so different accounts can both have e.g. `[Gmail]/All Mail` without collision.
  - `data/maildir/` — single maildir tree; paths are mailbox-scoped so we don’t mix files: e.g. `maildir/{mailbox_id}/cur/...` so `raw_path` in DB is `{mailbox_id}/cur/123_<msgid>.eml`. Keeps one store, clear ownership, and simple backup/restore per account if ever needed.
  - `data/vectors/`, `data/embedding-cache/` — shared (embeddings keyed by content; mailbox_id in application layer when needed).

- **Mailbox dirs** under `~/.zmail/` (e.g. `~/.zmail/me_gmail_com/`) hold **only identity and secrets**: that mailbox’s `.env` (IMAP password). No DB, no maildir, no vectors. So:
  - `~/.zmail/config.json` — all mailbox config (no secrets)
  - `~/.zmail/.env` — shared (e.g. OPENAI_API_KEY)
  - `~/.zmail/me_gmail_com/.env` — IMAP password for me@gmail.com
  - `~/.zmail/me_company_com/.env` — IMAP password for me@company.com
  - `~/.zmail/data/` — one DB, one maildir (with mailbox_id in paths and schema)

This keeps “one place for all durable data” and “mailbox dirs = config + secrets only.”

### Sync / refresh

- **Default:** `zmail sync` and `zmail refresh` run against **all** mailboxes in config (iterate mailboxes, connect with that mailbox’s config + that mailbox dir’s .env, write into the single DB and maildir with that mailbox_id).
- **Optional narrow scope:** e.g. `zmail sync --mailbox me@company.com` or `--mailbox me_company_com` to sync only that mailbox (useful for debugging or one-off backfill). Same for `zmail refresh`.

### Query language

- Agents and users can **filter on a specific inbox** when they want to. Add an optional **inbox/mailbox filter** in the query language: e.g. `inbox:work` or `mailbox:me_company_com`, supported in query parser + search layer (predicate on `messages.mailbox_id`). Default (no operator) = search all mailboxes.

### zmail status

- **List available inboxes** in `zmail status` — the list is short, so status is the right place. Agents and users can see which mailboxes are configured (and optionally sync state per mailbox) without a separate command.

## Schema impact

- **messages:** add `mailbox_id TEXT NOT NULL` (and backfill or default for existing single-inbox DBs).
- **sync_state:** key by `(mailbox_id, folder)` — e.g. composite primary key or `mailbox_id || '/' || folder` as key. Same for any other sync checkpoint tables.
- **FTS / search:** filter by `mailbox_id` when `inbox:` operator is present; otherwise search all.

## Backward compatibility

- Single-mailbox config today: one `imap.user`, one password in root `.env`. We preserve that: if `config.json` has no `mailboxes` array, treat as one mailbox (current shape). Root `.env` continues to supply `ZMAIL_IMAP_PASSWORD` for that single mailbox. So existing installs keep working without migration; multi-inbox is additive.

## Open questions

- Exact mailbox_id mapping: `@` → `_at_`, `.` → `_` (or leave dots and only replace `@`)?
- CLI flag name: `--mailbox <id|email>` vs `--account`?
- Default mailbox for “send” (when OPP-011 lands): config order, or explicit `default` in config?

## Summary

| Area | Choice |
|------|--------|
| **DB** | One unified SQLite DB; `mailbox_id` on messages and sync_state. |
| **Config** | Single config.json with `mailboxes` array; config only, no secrets. |
| **Secrets** | Root .env (shared e.g. OPENAI_API_KEY); per-mailbox dir `.env` (IMAP password). |
| **Mailbox dirs** | Identity + secrets only (e.g. `~/.zmail/me_gmail_com/.env`). No DB/maildir there. |
| **Data** | Single `~/.zmail/data/` (zmail.db, maildir with mailbox-scoped paths, vectors, cache). |
| **Sync** | Default: all mailboxes; optional `--mailbox` to narrow. |
| **Query** | Can filter on a specific inbox when desired (`inbox:` / `mailbox:` operator); default = all mailboxes. |
| **Status** | `zmail status` lists available inboxes (short list). |
