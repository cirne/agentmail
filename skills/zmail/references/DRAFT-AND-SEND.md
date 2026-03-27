# Draft and send — agent workflow (detail)

This companion to [`../SKILL.md`](../SKILL.md) describes how agents **compose, iterate, and send** email with zmail: **local drafts** on disk, **SMTP send-as-user**, and the same index as **`search` / `read` / `thread`**. For product rationale see **ADR-024** in `docs/ARCHITECTURE.md` at the repo or package root.

---

## Mental model

| Concept | What it means |
|--------|----------------|
| **Draft** | A file **`{id}.md`** under **`{ZMAIL_HOME}/data/drafts/`** (default `~/.zmail`). YAML frontmatter holds To/Cc/Bcc/Subject/reply metadata; the body is Markdown. |
| **`id`** | Filename **stem** (subject slug + `_` + eight alphanumeric chars). Use this with **`zmail send <id>`** and MCP **`send_draft`** (with or without **`.md`**). |
| **Send** | **SMTP** using the same mailbox credentials as IMAP. Successful send **moves** the draft to **`data/sent/`** (not the provider’s “Sent” UI unless the server mirrors it—zmail sends like a normal MUA). |
| **Not in Gmail Drafts** | Local drafts do **not** sync to the provider’s Drafts folder unless that feature is added later—treat them as **agent-local** until sent. |

---

## Prerequisites

- **`zmail setup`** (or wizard) completed; **`ZMAIL_IMAP_PASSWORD`** (and related) available for SMTP.
- For **LLM-assisted** steps: **`ZMAIL_OPENAI_API_KEY`** or **`OPENAI_API_KEY`** in **`.env`** — required for **`zmail draft new --instruction`**, **`zmail draft edit`**, and MCP **`create_draft`** with **`kind: "new"`** when **`subject`** is omitted (instruction-only compose).
- **`zmail draft rewrite`** and **`create_draft`** with explicit **subject + body** do **not** need OpenAI for the core path.

---

## Phase 1 — Gather context (before you draft)

| Goal | Typical commands / tools |
|------|-------------------------|
| Find a message to reply to | **`zmail search "…"`** or MCP **`search_mail`** → note **`message_id`** (and optionally **`thread_id`**) from results. |
| Read bodies for tone/facts | **`zmail read <message_id>`**, **`zmail thread <thread_id>`**, or MCP **`get_message` / `get_thread`**. |
| Fuzzy question (“what did X say about Y?”) | **`zmail ask "…"`** (single subprocess; uses OpenAI inside zmail). |

**Rule of thumb:** Know **who** you are replying to and **which `message_id`** applies before **`draft reply`** or **`create_draft`** with **`kind: "reply"`**.

---

## Phase 2 — Create a draft

### New email (no prior message)

**CLI**

```bash
# Explicit subject + body (no LLM)
zmail draft new --to 'colleague@example.com' --subject 'Project update' --body $'Hi,\n\nHere is the update.\n\n— You'

# LLM generates subject + body from instruction (needs OpenAI key)
zmail draft new --to 'colleague@example.com' --instruction 'Polite follow-up asking for ETA on the API review by Friday.'
```

**MCP** — `create_draft` with **`kind: "new"`**: supply **`to`**, **`subject`**, and **`body`**, **or** omit **`subject`** and pass **`instruction`** for LLM compose (see `docs/MCP.md` for required fields).

### Reply

**CLI** — Body via **`--body`**, **`--body-file`**, or **stdin** when not a TTY. **`--to`** / **`--subject`** override defaults (default recipient is the original sender; subject defaults to **`Re: …`**).

```bash
zmail draft reply --message-id '<message-id-from-search>' --body $'Thanks for the notes.\n\nI will send the doc tomorrow.'
```

**MCP**

```json
{
  "tool": "create_draft",
  "arguments": {
    "kind": "reply",
    "sourceMessageId": "<message-id-from-search>",
    "body": "Thanks — sounds good.\n"
  }
}
```

### Forward

**CLI** — requires **`--message-id`** and **`--to`**. Optional **`--subject`**, **`--body`** / **`--body-file`** / stdin for a preamble; zmail **inlines** the original message excerpt into the draft body.

```bash
zmail draft forward --message-id '<message-id>' --to 'team@example.com' --body $'FYI — see below.\n'
```

**MCP** — `create_draft` with **`kind: "forward"`**, **`forwardOf`** (message ID), **`to`**, and optional **`body`** (preamble; original is inlined like the CLI).

```json
{
  "tool": "create_draft",
  "arguments": {
    "kind": "forward",
    "forwardOf": "<message-id-from-search>",
    "to": "team@example.com",
    "body": "FYI — see below.\n"
  }
}
```

---

## Phase 3 — Review and revise

### View

```bash
zmail draft list [--text]              # all drafts: id, kind, subject
zmail draft view <id> [--text] [--with-body]
```

JSON default shows path and headers; **`--with-body`** includes the body in JSON.

### LLM revision (CLI only today)

```bash
zmail draft edit <id> 'Shorten the second paragraph and make the tone more formal.'
```

Uses OpenAI; instruction can also come from **stdin** (pipe).

### Literal replacement (no LLM)

```bash
zmail draft rewrite <id> 'Full new body text...' [--subject 'New subject'] [--to 'a@x.com,b@y.com']
# Or --body-file /path for large bodies
```

**MCP:** There is **no** `draft_edit` tool. Prefer **`zmail draft edit`** or **`zmail draft rewrite`** as a **subprocess** for revisions. If the agent can edit files safely, update the existing **`{id}.md`** under **`data/drafts/`** (YAML frontmatter + body) and proceed to **`send_draft`**—do **not** expect a second **`create_draft`** to update the same **`id`** (it always creates a **new** draft file).

---

## Phase 4 — Send

### CLI

```bash
zmail send <id> --dry-run    # validate recipients + SMTP config; no send
zmail send <id>              # send; on success draft moves to data/sent/
```

**One-shot** (no draft file): **`zmail send --to … --subject …`** (see **`zmail send --help`**).

### MCP

```json
{ "tool": "send_draft", "arguments": { "draftId": "<id>", "dryRun": true } }
```

```json
{ "tool": "send_draft", "arguments": { "draftId": "<id>" } }
```

**Shortcut without a draft file:** **`send_email`** with **`to`**, **`subject`**, **`body`** (see `docs/MCP.md`).

---

## Safety and testing

- **`ZMAIL_SEND_TEST=1`** — Restricts recipients to the dev/test allowlist (see **`zmail --help`** and ADR-024). Use when exercising send paths in non-production environments.
- **`--dry-run`** — **`zmail send`** and MCP **`send_draft`** / **`send_email`** validate without delivering.
- **Quoting** — Prefer **argument arrays** from agents; avoid pasting untrusted text into **`sh -c "zmail …"`** (injection risk).

---

## Quick comparison: CLI vs MCP

| Capability | CLI | MCP |
|------------|-----|-----|
| Create draft (new/reply/forward) | `zmail draft …` | `create_draft` |
| List / view drafts | `draft list`, `draft view` | `list_drafts` (list); view = read file or `draft view` |
| LLM edit existing draft | `zmail draft edit` | Subprocess to CLI, or replace `body` yourself |
| Literal rewrite | `zmail draft rewrite` | Same as above |
| Send | `zmail send <id>` | `send_draft` |
| One-shot send (no draft file) | `zmail send --to …` | `send_email` |

---

## Where to go deeper

- **CLI discovery:** `zmail draft --help`, `zmail send --help` — source of truth for flags.
- **MCP parameters:** `docs/MCP.md` (`send_email`, `create_draft`, `send_draft`, `list_drafts`).
- **Ask vs search/read:** `docs/ASK.md` (when to use **`zmail ask`** vs primitives for context).
