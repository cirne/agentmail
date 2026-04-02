---
name: zmail
description: >-
  Agent-native email: IMAP sync to local SQLite + FTS5—lightning-fast local search,
  structured JSON (no webmail UI). Assistants search, read, thread, attachments, draft, and send via CLI or MCP
  without leaving chat or terminal. Built for Claude Code, OpenClaw, Cursor, and any host with shell or MCP.
  Local-first primitives keep mail on-device; OpenAI powers `zmail ask`, `zmail check`, `zmail review`, setup/wizard, and `draft edit`.
  Requires `zmail` on PATH (install via install.sh from GitHub Releases — no Node), IMAP credentials, and an API key
  for LLM paths. OTP/login codes: optional `refresh`, then `search` + `read` (skill § Login / OTP).
  Source: github.com/cirne/zmail.
license: "Refer to https://github.com/cirne/zmail for project license and terms."
compatibility: >-
  `zmail` binary on PATH (from install.sh or cargo build). Network: IMAP, OpenAI (ask/check/review/setup),
  optional enrich providers. Disk: ~/.zmail (SQLite + maildir).
metadata:
  version: "0.2.4"
  homepage: "https://github.com/cirne/zmail"
  repository: "https://github.com/cirne/zmail"
  openclaw:
    requires:
      bins:
        - zmail
      config:
        - ZMAIL_EMAIL
        - ZMAIL_IMAP_PASSWORD
        - ZMAIL_OPENAI_API_KEY
---

# /zmail — Email your agent can actually use

**Tagline:** **Stay in agent / chat / zmail—skip the inbox tab.** Your mail is a **local SQLite + FTS5** index: **lightning-fast** search and reads over structured CLI/MCP output, not a mail website. Let **AI** handle triage, answers, and drafts (`zmail ask`, `check`, `review`, `draft` …) so you **never have to stare at a traditional inbox** for routine work.

**What it is:** Not a human mail UI. **IMAP** sync, maildir-style storage, **FTS5** search, **SMTP send-as-user**. Same pipeline from **Claude Code**, **OpenClaw**, **Cursor**, or automation (see [Agent workflow: draft and send](#agent-workflow-draft-and-send)).

**Why:** **Local-first** primitives (`search`, `read`, `thread`, …) stay on your machine; LLM-backed features (`ask`, `check`, `review`, `draft edit`, setup) call **OpenAI**—use when the mailbox owner accepts that tradeoff.

**Personalization:** To make **`zmail check`** and **`zmail review`** smarter over time, keep durable inbox rules and user context in **`~/.zmail/rules.json`** and prefer **`zmail rules ...`** when the installed version exposes it. That gives the agent a stable memory for what to **notify**, **inform**, and **ignore** instead of relearning preferences every turn. **`ignore`** decisions auto-archive locally on scan; for mail that was **surfaced** (`notify` / `inform`), use **`zmail archive`** (or MCP **`archive_mail`**) when done. Workflow, examples, and maintenance guidance: [references/INBOX-CUSTOMIZATION.md](references/INBOX-CUSTOMIZATION.md).

## Transparency (registries & security review)

Use this block to keep **ClawHub / OpenClaw registry fields** aligned with the skill body—avoid “no credentials required” when the CLI clearly needs secrets.

| Topic | What to declare |
|--------|------------------|
| **Provenance** | Source and issues: **[github.com/cirne/zmail](https://github.com/cirne/zmail)** |
| **Install** | **`curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh \| bash`** (prebuilt Rust binary from GitHub Releases). Prerelease: add **`--nightly`**. See repo **`AGENTS.md`**. Legacy npm **`@cirne/zmail`** exists for reference only. |
| **On PATH** | Default install: **`~/.local/bin/zmail`** — ensure **`~/.local/bin`** is on **`PATH`**, or set **`INSTALL_PREFIX`**. |
| **Required secrets (after setup)** | **`ZMAIL_EMAIL`**, **`ZMAIL_IMAP_PASSWORD`** (IMAP; e.g. Gmail app password). **`ZMAIL_OPENAI_API_KEY`** or **`OPENAI_API_KEY`** for setup wizard, **`zmail ask`**, **`zmail check`**, **`zmail review`**, and **`zmail draft edit`**. |
| **Privacy / data leaving the device** | **`zmail ask`**, **`zmail check`**, **`zmail review`**, and **`zmail draft edit`** (LLM revision) can send **email-derived or draft content** to **OpenAI**. Only use them if the **mailbox owner** accepts that tradeoff. Primitives **`search` / `read` / `thread` / `attachment`** and **`zmail draft rewrite`** (literal body replace, no LLM) are local only once mail is synced. |
| **Credentials on disk** | Secrets live under **`ZMAIL_HOME/.env`** (and non-secret settings in **`config.json`**). They are used only to talk to **your** IMAP host and (when configured) **OpenAI**—not to third-party analytics or the zmail project. Treat **`.env`** like any password file (permissions, backups, don’t paste into chats). |
| **IMAP / send posture** | **SMTP send-as-user** via **`zmail send`** (including **`zmail send <draft-id>`**) and **`zmail draft …`** (and MCP `send_email` / `create_draft` / `send_draft` / `list_drafts`). Optional **`ZMAIL_SEND_TEST=1`** restricts recipients to **`lewiscirne+zmail@gmail.com`** for dev/test sends. Sync remains a **local cache** of server mail—deleting local data does not remove server-side mail. |
| **MCP (optional)** | **`zmail mcp`** uses **stdio** JSON-RPC only (stdin/stdout)—**no** in-process HTTP server or listening TCP port for MCP. |
| **Persistence & local wipe** | Config and a **local** copy of mail (SQLite index + maildir cache under **`data/`**) live under **`ZMAIL_HOME`** (default **`~/.zmail`**). Rewriting local config or clearing local data does **not** delete mail on the **IMAP server**; after setup, run **`zmail update --since …`** to rebuild/backfill the local cache from IMAP. You still lose unsaved **local-only** state (e.g. extracted-attachment cache, soft inbox surfaced state, any data not on the server). |
| **Shell safety** | Invoke **`zmail`** with **argument arrays** (or careful quoting). **Never** paste untrusted mail text or chat content into a **`sh -c "zmail …"`** string—**command-injection** risk. |

OpenClaw parses **`metadata.openclaw.requires`** per [Creating skills](https://docs.openclaw.ai/tools/creating-skills): **`bins`** = executables expected on **`PATH`** (**`zmail`** exists only **after** the global install step). **`config`** lists environment variables this workflow expects for a configured mailbox (mirror the same in ClawHub package metadata if the UI has separate fields).

---

## Agent checklist

1. Install **`zmail`** (see [Install](#install)); confirm **`which zmail`**.
2. If **`~/.local/bin`** was added, **`hash -r`** / new shell so **`PATH`** picks up the binary.
3. Choose setup: **[`zmail wizard`](#zmail-wizard-interactive-humans)** (TTY) or **[`zmail setup`](#zmail-setup-agents--automation)** (flags/env, no prompts).
4. User must have a **Gmail app password** (or compatible IMAP credentials)—[Gmail: app password](#gmail-get-an-app-password).
5. Run **`zmail update --since …`** then **`zmail update`** / **`zmail status`**.
6. **Keep the index fresh:** **`search`**, **`read`**, **`thread`**, **`attachment`**, and **`ask`** only see mail already synced locally—run **`zmail update`** regularly (especially before mail work when **recency** matters), and recommend the user **schedule** **`zmail update`** (cron, launchd, or a host **heartbeat**) so new mail is indexed without manual steps ([Keeping mail fresh](#keeping-mail-fresh-indexed-and-searchable)).
7. **Learn the CLI from the CLI** (use the **Rust** `zmail` from **`install.sh`** / releases): run **`zmail`**, **`zmail --help`**, **`zmail --version`** (**`install.sh`** reinstall/upgrade lines), and **`zmail <command> --help`** (e.g. **`zmail draft --help`** for compose, LLM **`draft edit`**, **`draft rewrite`**, **`--text`** output). Read any **`hint`** (and truncation fields) in **JSON** output—zmail uses them to disclose the next capability ([Canonical docs & discovery](references/CANONICAL-DOCS.md)).
8. For questions over mail, prefer **`zmail ask`** first; use **`search` / `read` / `thread` / `who` / `attachment`** when you need fine control ([Ask vs primitives](#zmail-ask-vs-primitives)). To **reply or send**, follow **[Agent workflow: draft and send](#agent-workflow-draft-and-send)** (detail: [references/DRAFT-AND-SEND.md](references/DRAFT-AND-SEND.md)).
9. For recurring inbox triage, maintain durable rules/context so the agent can personalize **`zmail check`** and **`zmail review`** over time instead of treating every pass as stateless. See [references/INBOX-CUSTOMIZATION.md](references/INBOX-CUSTOMIZATION.md).
10. **Login / OTP / verification codes:** prefer **`update` (optional) → `search` → `read`** on the **local index**—do not assume the code only appears in **`update`** output; full steps: [Login / OTP / verification codes](#login--otp--verification-codes) and [references/AUTH-CODES.md](references/AUTH-CODES.md).
11. Never paste secrets into chat logs; use env or flags in the **user’s** shell.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | bash
```

- **Prerelease / nightly builds:** `curl -fsSL .../install.sh | bash -s -- --nightly`
- **Specific version:** `ZMAIL_VERSION=v1.2.3 curl -fsSL .../install.sh | bash` (or pass **`--version v1.2.3`** to the script when run from a clone).
- **Install directory:** defaults to **`~/.local/bin`**; override with **`INSTALL_PREFIX`**.
- **From source:** clone the repo, then **`cargo install-local`** (set **`INSTALL_PREFIX`**). See **`AGENTS.md`**.
- **Windows:** download the **`.zip`** for **`x86_64-pc-windows-msvc`** from [Releases](https://github.com/cirne/zmail/releases); the shell installer is macOS/Linux only.

Config and data default to **`ZMAIL_HOME`** (default **`~/.zmail`**): `config.json`, `.env`, and `data/` (SQLite + maildir).

---

## Gmail: get an app password

Gmail does **not** allow normal account passwords for IMAP clients. Use a **16‑character app password**.

1. **Turn on 2‑Step Verification** (required):  
   [Google Account → Security → 2‑Step Verification](https://myaccount.google.com/signinoptions/two-step-verification)
2. **Create an app password** (sign in with Google account):  
   [App passwords](https://myaccount.google.com/apppasswords)  
   - Choose app: **Mail** (or **Other** and name it `zmail`).  
   - Google shows a **16‑character** password (often shown in groups; enter **without spaces**).
3. Use **full Gmail address** as IMAP user (e.g. `you@gmail.com`) and the app password as **`ZMAIL_IMAP_PASSWORD`** / `--password`.

If app passwords are disabled (workspace policy, account type), the user must use whatever IMAP credentials their admin allows.

---

## `zmail wizard` (interactive humans)

- **When:** Real terminal with TTY; user is present to answer prompts.
- **Run:** `zmail wizard`  
  Optional: `--no-validate` (skip live IMAP/OpenAI checks), `--clean` (wipe local config + cached mail under `ZMAIL_HOME`; IMAP unchanged; may prompt unless `--yes`).
- **If stdin is not a TTY** (agents, CI, pipes): wizard **exits** with a message to use **`zmail setup`** instead.
- Wizard walks through email, IMAP app password, OpenAI key, default sync window, and can **start background sync** at the end.

---

## `zmail setup` (agents & automation)

**Non-interactive.** No prompts when all inputs are provided via **flags** and/or **environment variables**.

**Required today (all three):**

| Input | Flag | Environment variable |
|--------|------|----------------------|
| Email (IMAP user) | `--email` | `ZMAIL_EMAIL` |
| IMAP password (e.g. Gmail app password) | `--password` | `ZMAIL_IMAP_PASSWORD` |
| OpenAI API key | `--openai-key` | `ZMAIL_OPENAI_API_KEY` or `OPENAI_API_KEY` |

**Examples:**

```bash
zmail setup \
  --email 'user@gmail.com' \
  --password 'abcdefghijklmnop' \
  --openai-key 'sk-...'
```

```bash
export ZMAIL_EMAIL='user@gmail.com'
export ZMAIL_IMAP_PASSWORD='abcdefghijklmnop'
export ZMAIL_OPENAI_API_KEY='sk-...'
zmail setup
```

**Optional flags:**

| Flag | Meaning |
|------|--------|
| `--no-validate` | Skip IMAP and OpenAI validation (faster/offline-ish write of config only). |
| `--default-since <spec>` | Default sync window in config (e.g. `7d`, `1y`). Default if omitted: `1y`. |
| `--clean --yes` | Delete existing `config.json`, `.env`, and `data/` under `ZMAIL_HOME`, then write new config. **Local only**—IMAP mailbox unchanged; resync rebuilds the index/cache. |

If any required value is missing, `zmail setup` prints what’s missing and exits—fix env/flags and retry.

**OpenAI key:** Required for **`zmail setup`** / **`zmail wizard`** as shipped. It is stored in **`~/.zmail/.env`**. Same key powers **`zmail ask`**, **`zmail check`**, **`zmail review`**, **`zmail draft edit`** (natural-language revisions), and related features. Search/read/thread/who/attachment and **`zmail draft rewrite`** do **not** need the API for the core path once mail is indexed.

---

## Agent workflow: draft and send

zmail treats **agents as the compose surface**: outbound mail is a **local draft** (Markdown + YAML under **`{ZMAIL_HOME}/data/drafts/`**), then **SMTP send-as-user** with the same credentials as IMAP—no separate “send API.” Architecture: **[ADR-024](https://github.com/cirne/zmail/blob/main/docs/ARCHITECTURE.md)**.

### Phases (new mail, replies, forwards)

1. **Gather context** — For replies/forwards, obtain **`message_id`** (and facts/tone) via **`search` → `read` / `thread`**, or use **`zmail ask`** for fuzzy questions. Skip this for cold **new** mail if the user already gave recipients and intent.
2. **Create a draft** — **`zmail draft new|reply|forward`** or MCP **`create_draft`** (`kind`: `new` | `reply` | `forward`). For **new** mail, either pass **subject + body** or use **`--instruction`** / LLM compose (requires OpenAI key).
3. **Review and revise** — **`zmail draft view`** / **`draft list`**; optional **`zmail draft edit <id> "…"`** (LLM) or **`draft rewrite`** (literal body/subject/to). MCP has no `draft_edit` tool—**subprocess** those CLI commands, or edit the draft **`.md`** file in **`data/drafts/`** if your environment allows safe file access.
4. **Send** — **`zmail send <draft-id> --dry-run`** then **`zmail send <draft-id>`**, or MCP **`send_draft`** (optional **`dryRun`**). Success **moves** the file to **`data/sent/`**. One-shot without a draft file: **`zmail send --to …`** or MCP **`send_email`**.

**Defaults:** Mutating draft commands return **JSON**; add **`--text`** for human-readable output like **`draft view`**.

**Safety:** Optional **`ZMAIL_SEND_TEST=1`** restricts recipients for dev/test—see **`zmail --help`** and ADR-024.

**Full workflows, CLI/MCP examples, and comparison table:** [references/DRAFT-AND-SEND.md](references/DRAFT-AND-SEND.md).

---

## Secrets and files (after setup)

| Secret / file | Required? | Purpose |
|---------------|-----------|---------|
| `ZMAIL_IMAP_PASSWORD` in **`.env`** | **Yes** (for sync) | IMAP login (Gmail app password). |
| `ZMAIL_OPENAI_API_KEY` (or `OPENAI_API_KEY`) in **`.env`** | **Yes** at setup; **yes** for `ask` / `check` / `review` / `draft edit` | LLM features (+ LLM draft revision). |
| **`config.json`** | **Yes** | Non-secret: IMAP host/port/user, sync defaults (no password in this file). |
| **`ZMAIL_HOME`** | Optional | Override config root (default `~/.zmail`). |

**Security:** Treat **`.env`** like credentials—don’t commit it, don’t paste into tickets or agent transcripts. Rotate app passwords if exposed.

---

## First sync and daily use

```bash
zmail update --since 30d  # initial backfill (often runs in background; note log path on stdout)
zmail update              # fetch new mail since last sync
zmail status              # local sync + index health
zmail check               # updates first, then urgent-only pass
zmail review 24h          # summary-worthy recent mail
zmail ask "your question" # one-shot NL answer (OpenAI); good default for agents
zmail search 'query'      # FTS hits (JSON default; --text for tables)
```

- Long **`update --since …`:** Safe to run in background; use **`zmail status`** and the **sync log file** path the CLI prints.
- Plain **`update`** is the habitual “get new mail” command after the first backfill.
- **Outbound:** use **[Agent workflow: draft and send](#agent-workflow-draft-and-send)** (`zmail draft …`, then **`zmail send <draft-id>`**; see [references/DRAFT-AND-SEND.md](references/DRAFT-AND-SEND.md)).

---

## Login / OTP / verification codes

**Goal:** Find a **sign-in / verification / MFA code** and report it with **sender, time (date), subject**, and enough context to choose the right message if several match.

**Do not** rely on **`update`**’s new-mail preview alone—the code may **already** be in the local index from an earlier sync. **Source of truth:** **`zmail search`** (then **`zmail read`** on the best **`message_id`**s).

**Default path (no OpenAI on the core path):** optional **`zmail update`** (see **`zmail update --help`**), then **`zmail search`** with a **recent window** and auth-ish keywords, then **`zmail read <message_id>`** for the body/snippet if needed. Prefer **primitives** over **`zmail ask`** / **`zmail check`** / **`zmail review`** here—avoids sending mail content to an LLM for a simple lookup.

**Detail, search hints, MCP parity, and a short output template:** [references/AUTH-CODES.md](references/AUTH-CODES.md).

---

## Keeping mail fresh (indexed and searchable)

**Local** **`search`**, **`read`**, **`thread`**, **`attachment`**, and **`ask`** only see messages that have been **pulled from IMAP and indexed**. Mail that arrived on the server **after** the last sync is **not** in SQLite/FTS until another sync runs.

**Agents**

- Run **`zmail update`** **before** **`search` / `read` / `thread` / `attachment` / `ask`** when **recency** matters (e.g. “anything today?”, “did they reply yet?”, “latest from X”). In **long sessions**, update again if the user is waiting for new mail or you have not synced recently.
- Use **`zmail status`** when you need a quick read on whether the local cache looks current.

**Users (automation)**

- Do not rely on the agent alone: **schedule** **`zmail update`** so the index stays current in the background—e.g. **cron** (Linux), **`launchd`** (macOS), **Task Scheduler** (Windows), or your orchestrator’s equivalent **heartbeat** / periodic job.
- **OpenClaw** can fold **`zmail update`**, **`zmail check`**, and periodic **`zmail review`** into a **heartbeat** checklist (often preferable to a raw cron for agent hosts)—see [OpenClaw: heartbeat + fresh mail](#openclaw-heartbeat--fresh-mail).

---

## zmail ask vs primitives

**`zmail ask "<question>"`** runs zmail’s **answer pipeline** in one go: it figures out how to search and pull the right messages, then **synthesizes a complete answer** for the user. For the **calling agent**, that usually means **fewer steps** and a **ready-made summary**—best when the goal is “answer this question about my mail” rather than “give me raw hits.” Requires **`ZMAIL_OPENAI_API_KEY`** (or `OPENAI_API_KEY`). Optional **`--verbose`** if you need to trace what it did.

**Primitives** (`search`, `read`, `thread`, `who`, `attachment list` / `attachment read`) expose **structured, explicit steps**: you choose the query, which **message IDs** to open, whether you need **full body or raw**, **threads**, **contacts**, or **extracted attachment text**. They do **not** call OpenAI for the core path—good for **scripts**, **tight filters**, **verbatim quotes**, **debugging**, or when the outer agent wants to **own the reasoning** and token budget.

| Prefer **`zmail ask`** | Prefer **primitives** |
|------------------------|------------------------|
| Broad or fuzzy questions (“what did X say about the launch?”) | Exact filters, known IDs, pagination |
| You want a **single** synthesized answer quickly | You need **every** matching row or **full** message bodies |
| User asked in natural language and doesn’t care about IDs | **Attachments**, EML/raw, or **who** / address-book style lookups |

**Rule of thumb:** **Start with `ask`.** If the answer is too shallow, wrong, or you need **more detail or accuracy**, switch to **`search` → `read` / `thread`** (and **`attachment`** when documents matter). Combine both: e.g. **`ask`** for orientation, then **`read`** on specific `message_id`s from search if you must verify.

Full tradeoffs and hybrid patterns: **`docs/ASK.md`** at the package/repo root (paths in [references/CANONICAL-DOCS.md](references/CANONICAL-DOCS.md)).

---

## Install this skill folder (hosts)

Copy the **`zmail`** directory (this skill) into an **end-user** location—not into the zmail **source** repo’s `.cursor/skills/` (those are dev-only).

| Host | Typical path |
|------|----------------|
| Cursor | `~/.cursor/skills/zmail/` or another project’s `.cursor/skills/zmail/` |
| Claude Code | `~/.claude/skills/zmail/` |
| OpenClaw | `<workspace>/skills/zmail/`, `~/.openclaw/skills/zmail/` — copy this folder from the repo or npm package tarball ([OpenClaw creating skills](https://docs.openclaw.ai/tools/creating-skills)) |

Folder name must stay **`zmail`** to match frontmatter `name` ([Agent Skills spec](https://agentskills.io/specification.md)). Copy the **whole** `skills/zmail/` directory (includes `references/`).

### OpenClaw: heartbeat + fresh mail

For **[OpenClaw](https://docs.openclaw.ai/)**, use a **heartbeat** (not a separate cron per mailbox tick) for periodic “anything new in email?” awareness—OpenClaw’s own guide recommends heartbeat for inbox-style checks because it **batches** with other routine work and can **suppress noise** when nothing matters. See **[Cron vs heartbeat](https://docs.openclaw.ai/cron-vs-heartbeat)** and **[Heartbeat](https://docs.openclaw.ai/gateway/heartbeat)** (interval, `HEARTBEAT.md`, `HEARTBEAT_OK`, `agents.defaults.heartbeat`, etc.).

**Put zmail on the workspace `HEARTBEAT.md` checklist**, for example:

1. **Ingest new mail:** run **`zmail update`** so the local index is current.
2. **Urgent pass:** run **`zmail check`** when the heartbeat should notify only about interruption-worthy messages.
3. **Review pass:** run **`zmail review 24h`** (or another window) on a slower cadence when the heartbeat should summarize what is worth knowing but not urgent.
4. **If nothing needs a human ping**, answer **`HEARTBEAT_OK`** so OpenClaw drops the turn quietly (per Heartbeat docs).

**Cost / habit:** `update` alone does **not** call OpenAI; **`check`** and **`review`** do. Keep the checklist short; widen the review window only when needed.

---

## More detail

- [references/CANONICAL-DOCS.md](references/CANONICAL-DOCS.md) — **CLI-first discovery** (`zmail`, `--help`, per-command help), **hints in output**, and a **table of canonical markdown** (`AGENTS.md`, `docs/VISION.md`, `docs/ASK.md`, `docs/ARCHITECTURE.md`, `docs/MCP.md`, OPP-025).
- [references/AUTH-CODES.md](references/AUTH-CODES.md) — **Login / OTP / verification codes:** update + search + read, time filters, privacy (skip LLM), MCP.
- [references/DRAFT-AND-SEND.md](references/DRAFT-AND-SEND.md) — **Compose, reply, forward, revise, send** — detailed agent workflow, CLI and MCP examples, safety.
- [references/INBOX-CUSTOMIZATION.md](references/INBOX-CUSTOMIZATION.md) — **Make `zmail check` and `zmail review` smarter over time:** durable rules, user context, notify/inform/archive/suppress behavior, and agent maintenance patterns.
