# OPP-011: Send Email — Draft + SMTP

**Status:** **Shipped in repo** (2026-03). SMTP send-as-user, local drafts, LLM **`draft edit`**, literal **`draft rewrite`**, Markdown→plain on send, forward body inlining from raw maildir, optional SMTP verify in setup/wizard, and MCP send/draft tools are implemented; product sequencing may still treat broad *marketing* emphasis on send as gated on read/sync validation — see **Blocked by** below.

**Canonical technical decisions:** [ADR-024](../ARCHITECTURE.md#adr-024-outbound-email--smtp-send-as-user--local-drafts) in [ARCHITECTURE.md](../ARCHITECTURE.md).

## Context

zmail was read-only for outbound mail until this work. The vision (see [VISION.md](../VISION.md) — "The Full Loop") is read + write: the agent is the complete interface. User never opens inbox, never opens compose.

## What is implemented (so far)

### SMTP send-as-user

- **Config:** Optional `smtp` in `~/.zmail/config.json` (`host`, `port`, `secure`); otherwise inferred from `imap.host` (e.g. `imap.gmail.com` → `smtp.gmail.com:587` STARTTLS). Same password as IMAP (`ZMAIL_IMAP_PASSWORD`).
- **Code:** `src/send/` — `resolveSmtpSettings`, nodemailer transport, `sendSimpleMessage`, `sendRawRfc822`, `sendDraftById`, reply threading from raw `.eml` via mailparser (`loadThreadingFromSourceMessage`).
- **CLI:** `zmail send --to … --subject … [--body …]`; `zmail send --raw` (stdin or `--file`); `zmail send <draft-id>` (positional draft id).
- **MCP:** `send_email`, `create_draft`, `send_draft`, `list_drafts` — same pipeline as CLI where applicable.

### Local drafts

- **On disk:** `{dataDir}/drafts/<uuid>.md` — YAML frontmatter + body; `{dataDir}/sent/` holds archived draft files after successful send.
- **CLI:** `zmail draft new|reply|forward|list|view|edit|rewrite` — **`edit <id> <instruction…>`** = LLM revises draft (OpenAI); **`rewrite <id> <body…>`** = literal body replace; default JSON; **`--text`** = full human-readable draft (same layout as **`draft view`**).
- **Reply:** `threadId` / `sourceMessageId` stored; `In-Reply-To` / `References` for **reply** sends are built from the source message’s raw maildir file (not from SQLite columns).

### Dev/test safety

- Default: **only** `lewiscirne+zmail@gmail.com` may appear in To/Cc/Bcc unless **`ZMAIL_SEND_PRODUCTION=1`** (see `src/send/recipients.ts`). Documented in ADR-024, CLI help, MCP tool descriptions, and [AGENTS.md](../../AGENTS.md).

### Out of scope for this first pass (unchanged intent)

- Mailgun/SendGrid-style relays as default; OAuth2-only SMTP; **configurable signatures** (see [Key requirement](#key-requirement-configurable-signatures) below); voice profile; tagline; IMAP `Drafts` folder sync.

---

## Opportunity (original spec — retained for direction)

Add send capability via SMTP (send-as-user through Gmail/Outlook/Fastmail). Same credentials as IMAP, same identity, sent mail appears in the provider’s **Sent** folder with normal threading, low deliverability risk.

### SMTP configuration (keep it simple)

**Default: use the same provider as IMAP** — not a separate email API (Mailgun, SendGrid, Postmark, etc.). The user already has an app password or equivalent for sync; **SMTP submission reuses that identity** (`From` matches the mailbox, replies thread correctly, copy lands in **Sent** alongside the rest of the account). One mental model: “zmail is my mailbox,” not “zmail is a mailgun client.”

**Configuration surface (minimal):**

- **Happy path — inferred defaults:** From existing `imap.host` (or provider preset), derive `smtp.host` / port / TLS (e.g. Gmail: `smtp.gmail.com`, port **587** STARTTLS). User adds **no new secrets** if SMTP uses the same password as IMAP (`ZMAIL_IMAP_PASSWORD` today; optionally alias as “mail password” in docs).
- **Overrides when needed:** Optional `smtp.host`, `smtp.port`, `smtp.secure` in `config.json` for odd corporate hosts or nonstandard ports — same pattern as IMAP overrides.
- **Explicit non-goals for v1:** Per-message API keys, Mailgun domains, and “send from arbitrary relay” add onboarding and identity confusion; treat as **out of scope** unless a later opp needs “send from marketing domain” or similar.

**Why not Mailgun-style as default?** Second signup, API key management, often a **different sending domain** or envelope behavior, and **Sent** / threading may not match what users expect from their normal client. Good for product email at scale; wrong default for **personal send-as-user** from the mailbox zmail already syncs.

**Future note:** Some providers push OAuth2 for SMTP; app-password flow may need a follow-up.

---

## Implemented vs planned CLI / drafts (checklist)

| Item | Status |
|------|--------|
| `zmail send` (flags + `--raw` + `<draft-id>` + `--dry-run`) | Done |
| `zmail draft list|view|new|reply|forward|edit|rewrite` | Done |
| `draft edit <id> <instruction…>` (LLM revision) | Done |
| `draft rewrite <id> <body…>` (literal) + optional `--subject` / `--to` / `--body-file` | Done |
| Mutating draft commands: JSON default; **`--text`** = full draft (reuse `formatDraftViewText`) | Done |
| Markdown body → plain text at send (`sendDraftById`) | Done |
| Forward: inline quoted original from raw maildir | Done |
| Optional SMTP `verify()` in `zmail setup` / `zmail wizard` (skipped with `--no-validate`) | Done |
| MCP: `draft edit` equivalent | **Not done** — use CLI subprocess or agent edits `body` + `create_draft` |
| Fake-SMTP integration tests in CI | **Partial** — unit tests; optional `smtp-server` devDependency |

---

## Remaining work (prioritized)

1. **Product / docs polish:** Remove or relax the dev-only recipient allowlist for production installs (keep `ZMAIL_SEND_PRODUCTION` or replace with a clearer policy).
2. **Testing:** Optional `smtp-server` (or transport mock) integration test for `sendMail` envelope; richer MCP tool tests.
3. **MCP:** Optional `rewrite_draft` / `edit_draft` tools matching CLI semantics.
4. **OAuth2 SMTP** for providers that disable app passwords (follow-up opp or section of this doc).
5. **IMAP Append to Drafts** so local drafts appear in Gmail Drafts UI (optional).
6. **Phase 3 (vision):** Voice profile from sent history; “Sent via zmail” tagline; deeper intent-to-action flows.
7. **Signatures (key requirement):** See [Key requirement: configurable signatures](#key-requirement-configurable-signatures) below.

---

## Key requirement: configurable signatures

**Not implemented yet.** Outbound mail should support **one or more user-defined signatures**, stored in the same configuration surface as the rest of zmail (e.g. `signatures` in `~/.zmail/config.json`, or a dedicated file under `ZMAIL_HOME` referenced from config — single canonical location TBD in ADR/config schema).

- **User control:** Each signature is a named block (e.g. `"work"`, `"personal"`) or ordered list; drafts/send pick a default or an explicit id. Format: plain text and/or Markdown with deterministic conversion at send (aligned with existing draft→plain behavior).
- **Onboarding / wizard (optional):** Use an LLM **once during setup** (or a `zmail setup --suggest-signatures` flow) to **recommend** candidate signatures by scanning **historically sent mail** already synced into the local index — e.g. detect recurring closings, title/phone blocks, disclaimers — without guessing secrets. User confirms or edits before persisting to config.
- **Agent use:** MCP/CLI should expose enough metadata (active signature id, list of ids) that agents append the right closing when creating or editing drafts.

This is distinct from the broader **voice profile** phase (tone/length per recipient); signatures are explicit, user-owned text the model should not invent without config.

---

## Proposed CLI (historical sketch — largely superseded by implementation above)

Treat each outgoing message as a **draft object** with a stable id, stored under the zmail data directory (`drafts/` + `sent/`). State machine: **create → iterate → send**.

**Contract for agents** (implemented): mutating commands print JSON by default (or **`--text`** for human-readable full draft); stable draft ids; **`draft edit`** takes a natural-language instruction; **`draft rewrite`** replaces body text literally.

### Draft file format (on disk)

Markdown with YAML frontmatter — see `src/send/draft-store.ts`. **Forward** drafts include an inlined quoted original from the source message’s raw `.eml` when created (CLI + MCP `create_draft` forward).

**Local drafts vs provider Drafts:** Pre-send drafts live under zmail’s data dir only; they do **not** sync to IMAP `Drafts` in v1.

**MCP parity:** Single pipeline; tools `send_email`, `create_draft`, `send_draft`, `list_drafts`.

**Phases (reconciled with raw send):**

1. **Send only** — Shipped: `zmail send`, MCP `send_email`.
2. **Draft + confirm** — Shipped: `zmail draft …`, `zmail send <draft-id>`, MCP `create_draft` / `send_draft` / `list_drafts`. Optional tagline **not** shipped.
3. **Voice profile** — Not started.

**Note on round-trips:** Answering mail is covered by `zmail ask` for orchestration ([ASK.md](../ASK.md)).

**Killer differentiators (still vision):**

- Voice profile from history.
- Tagline as advertisement ("Sent via zmail").
- Intent-to-action end-to-end.

---

## Blocked by

**Product validation:** Core read/sync/search/onboarding should still be validated with real users before treating “send” as a **primary** marketing surface — even though the **implementation** exists behind normal config and dev/test guards.

Agent-friendly setup ([OPP-009](archive/OPP-009-agent-friendly-setup.md)) is implemented.
