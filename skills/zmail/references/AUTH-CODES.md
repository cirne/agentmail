# Login, OTP, and verification-code email

End-user **`/zmail`** skill detail. **Developing** zmail: use repo **`.cursor/skills/`**, not this file.

---

## Workflow (CLI)

1. **Optional:** `zmail refresh` — pulls new mail into the **same** local index `search` uses.
2. **Always:** `zmail search …` — the code may **already** be indexed; **do not** assume it only appears in `refresh` output.
3. **Then:** `zmail read <message_id>` on the best match(es) if the snippet is not enough (codes are often in the body).

**Avoid for this task:** `zmail ask` and `zmail inbox` — they send mail-derived text to **OpenAI**; verification lookup is usually a **local** `search` + `read`.

---

## Search tips

- **Recency:** `--after` / `--before` accept **ISO dates** (`YYYY-MM-DD`) or **relative** specs like `1d`, `7d`, `2w` (same family as `zmail refresh --since`; see `zmail search --help`). Example: `zmail search 'verification' --after 1d --limit 15`.
- **Keywords:** run one or two FTS queries, e.g. `verification code`, `sign in`, `one-time`, `OTP`, `security code`, plus the **service name** if the user said it (`slack`, `github`, …).
- **Known sender:** `--from partial@or.domain` when the user knows who sends the code.
- **Noise:** auth mail is usually not “promotional”; default search already excludes much noise. Use `zmail search --help` if you need `--include-noise`.
- Read JSON **`hint`**, **`returned`**, **`totalMatched`** — same as other searches ([CANONICAL-DOCS.md](CANONICAL-DOCS.md)).

---

## MCP (same index)

After an optional `refresh` via CLI (or your host’s sync), use **`search_mail`** with `query`, `afterDate` / `beforeDate`, optional `fromAddress`, then **`get_message`** or batched **`get_messages`**. Inline operators in `query` include `after:`, `before:`, `from:` (see **`docs/MCP.md`** in the package/repo).

---

## What to tell the user

For each candidate (or the one clear winner), surface at least:

- **Code** (or “not visible in excerpt—see full read”)
- **From** (address / name)
- **Date/time** (as returned by search/read)
- **Subject**
- **`message_id`** (if they need to open thread: `zmail thread …`)

If **several** recent messages match, list the **newest plausible** first and say why; never guess a code from the wrong message.

---

## Security

Treat codes like **secrets** in chat: minimize quoting, don’t log full bodies unnecessarily, and don’t paste IMAP passwords or unrelated PII.
