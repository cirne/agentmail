# BUG-035: `zmail read` Omits To/CC/BCC (and Related Headers) — Agent-Reported

**Status:** Fixed (Rust). **Created:** 2026-04-01. **Tags:** read, cli, mcp, agent-first

**Resolution:** Implemented `parse_read_full` (single MIME parse): `zmail read` default output is headers + body; `--json` returns camelCase JSON including `threadId`, `to`/`cc`/`bcc`/`replyTo` as `{ name, address }`, `inReplyTo`, `references`, `recipientsDisclosed`, `body`. MCP `get_message` adds the same fields when the raw `.eml` can be read. Undisclosed recipients: `recipientsDisclosed: false` and text line `To: (undisclosed — …)` when To/Cc/Bcc are all absent.

**Design lens:** [Agent-first](../../VISION.md) — “Who is on this email?” is a core primitive alongside body and date. Forcing agents through `read --raw` and MIME parsing defeats the purpose of a structured local index and burns tokens (long Received/DKIM/ARC preamble; BCC may omit To/CC in headers).

---

## Summary

**Observed:** `zmail read <message-id>` emphasizes body (and related UX) but does **not** surface **To, CC, BCC** in default or JSON output in a structured way. Agents answering “Was X copied?” or building reply-all / forward recipient lists cannot rely on `read` alone.

**Workaround today:** `zmail read <id> --raw` plus manual header extraction — fragile, grep-unfriendly when transport headers dominate, and **BCC** cases may show no To/CC lines at all in the user-visible header block.

**Expected:** JSON (and `--text`) should include structured recipient metadata, for example:

- `to[]`, `cc[]`, `bcc[]` as `{ name, address }` (empty arrays when unknown; explicit **“undisclosed”** or similar when the provider omits recipients).
- Optionally in the same pass: **attachments** summary (filename, type, size) — today often requires `attachment list`; **In-Reply-To** / **References** for threading without a separate `thread` call; **Reply-To** if different from From.

Data from IMAP sync / SQLite should already include parseable To/CC; presentation and JSON schema are the main work.

---

## Real-world impact (reported session)

To determine if “Sterling” was on a conference dinner invite, the agent ran **five** CLI steps (`read`, raw pipes, grep, sed) instead of one, with BCC ambiguity.

---

## Recommendations

1. Extend **`read` JSON output** (and **MCP `get_message` / `get_messages`**) with `to`, `cc`, `bcc`, and document semantics for undisclosed/BCC.
2. Extend **`read --text`** with a short header block (From, To, Cc, Date, Subject) before the body.
3. Add **integration tests** for JSON shape and at least one BCC / undisclosed case.
4. Align MCP parity with CLI for the same fields ([BUG-025](../BUG-025-mcp-cli-parity-alignment-skill.md) may need a checklist update).

---

## References

- Vision: [VISION.md](../../VISION.md)
- Archived context (attachments on read, not recipients): [BUG-002 archive](BUG-002-attachment-discoverability-and-read.md)
- Feedback: `../ztest/feedback/submitted/ux-cli-agent-friction-and-read-missing-recipients.md` (Part 2)
