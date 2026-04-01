# OPP-033: IMAP Write Operations — Readonly by Default, Email Management When Enabled

**Status:** Open. **Created:** 2026-04-01. **Updated:** 2026-04-01. **Tags:** imap, archive, write, safety, config, inbox

**Related:** [OPP-032](OPP-032-llm-rules-engine.md) (stateful inbox, local archive semantics), [ADR-005](../ARCHITECTURE.md#adr-005-dual-agent-interface--native-cli--mcp-server) (agent-first CLI + MCP), [ADR-011](../ARCHITECTURE.md#adr-011-email-provider--imap-first-gmail-as-priority-target) (IMAP-first architecture), [ADR-027](../ARCHITECTURE.md#adr-027-stateful-inbox--no-daemon-soft-state-on-schema-bump) (stateful inbox decisions)

---

## Problem

**Keep open:** This is still a focused future opportunity. zmail currently updates only local archive/handled state; provider-side IMAP mutation semantics, config gating, and mutation-result reporting are still unshipped.

Today zmail is effectively read-only with respect to the provider mailbox. It syncs, indexes, searches, classifies, drafts, and sends outbound mail, but it does **not** mutate existing IMAP messages on the server.

That boundary is important. The moment zmail issues IMAP write commands, it stops being only an intelligence/indexing layer and starts becoming an email management system. That creates a new class of risk:

- accidental archive or mailbox mutation from an agent action
- mismatch between local state and provider state
- unclear user expectations around whether zmail is safe to run in automation
- provider-specific semantics for archive, move, flags, and labels

At the same time, durable inbox triage gets much better if zmail can eventually propagate handled-state back to the provider. A local archive bit is useful, but true mailbox management means the user's actual inbox state changes too.

The opportunity is to introduce IMAP write operations deliberately, behind an explicit config gate, with **readonly mode as the default**.

---

## Direction

### Readonly by default

zmail should remain read-only unless the user explicitly enables mailbox mutation.

Proposed config shape:

```json
{
  "mailboxManagement": {
    "enabled": false
  }
}
```

Default behavior:

- `enabled: false` means zmail never issues IMAP write commands
- local inbox features may still update SQLite (`is_archived`, `inbox_alerts`, `inbox_reviews`, `inbox_handled`, rules)
- CLI and agents should clearly indicate when an action is local-only because readonly mode is active

When enabled, zmail enters a new operational mode: email management. In that mode, inbox actions are allowed to mutate the provider mailbox.

### Archive is the first IMAP write action

The first write action should be archive, because it is the clearest extension of the stateful inbox model:

- `zmail review dismiss <message_id>` archives locally by default in [OPP-032](OPP-032-llm-rules-engine.md)
- when mailbox management is enabled, the same action should also archive at the provider via IMAP

This makes dismiss/archive the bridge from local inbox triage to real mailbox management.

### Scope this broadly, not as a one-off

This should not be framed as "just add archive via IMAP." It is the beginning of a broader provider-write layer with explicit safety semantics.

Once enabled, future actions may include:

- archive
- unarchive
- mark read / unread
- move to folder
- apply/remove labels where provider semantics support it

The architecture should therefore establish:

- capability gating via config
- a clear abstraction for mailbox mutations
- audit/debug output so callers know whether a mutation was attempted and whether it succeeded
- provider-specific behavior for Gmail vs generic IMAP

---

## Proposed behavior

### CLI semantics

Readonly mode:

```text
zmail review dismiss <message_id>
```

Behavior:

- records surfaced/handled state locally
- sets `is_archived = 1` locally unless `--no-archive`
- does **not** mutate the provider mailbox
- response should indicate `providerMutation: skipped (readonly mode)`

Mailbox management enabled:

```text
zmail review dismiss <message_id>
```

Behavior:

- does the same local state update
- attempts provider-side archive via IMAP
- reports success/failure explicitly

Example JSON response:

```json
{
  "messageId": "abc123",
  "dismissed": true,
  "archivedLocal": true,
  "providerMutation": {
    "attempted": true,
    "action": "archive",
    "success": true
  }
}
```

Readonly-mode example:

```json
{
  "messageId": "abc123",
  "dismissed": true,
  "archivedLocal": true,
  "providerMutation": {
    "attempted": false,
    "reason": "readonly_mode"
  }
}
```

### User model

Two explicit modes:

- **Readonly mode**: zmail can observe, classify, and manage local state, but never changes the provider mailbox
- **Mailbox management mode**: zmail is allowed to mutate the provider mailbox for supported actions

This keeps the default safe for automation while giving advanced users a clear opt-in path to deeper email management.

---

## Design questions

### What does "archive" mean across providers?

Archive is not uniform:

- Gmail: typically remove `\\Inbox` while keeping the message in All Mail
- generic IMAP: often move the message to an Archive folder, but folder naming and existence vary

So "archive" should be a semantic action in zmail, implemented by provider-specific adapters.

### How should failures behave?

If local archive succeeds but provider archive fails:

- local state should remain explicit
- the CLI should report partial success
- diagnostics should make the mismatch visible
- retries should be possible

This argues for modeling local state and provider mutation results separately, not as one opaque success bit.

### How should this be configured?

Likely needs more than one boolean over time. A staged design might be:

```json
{
  "mailboxManagement": {
    "enabled": false,
    "allow": ["archive"]
  }
}
```

Start with a simple boolean if needed, but the design should leave room for per-action capability control.

### What should agents be allowed to do automatically?

Even when mailbox management is enabled, some users may want:

- automatic archive allowed
- move/label operations disabled
- explicit confirmation for destructive-looking actions

This is a product and safety question, not just a transport question.

---

## Phasing

1. **Define capability boundary.** Add config for readonly-by-default vs mailbox-management-enabled.
2. **Add archive mutation abstraction.** Model provider write operations separately from local inbox state.
3. **Ship archive via IMAP.** `dismiss` / archive actions update the provider mailbox when enabled.
4. **Add observability.** Return structured mutation results to CLI/MCP callers.
5. **Expand cautiously.** Consider unarchive, mark read/unread, move, and labels only after archive is proven safe.

---

## Test strategy

- **Unit:** Config parsing for readonly vs mailbox-management-enabled.
- **Unit:** Provider capability mapping for archive action (Gmail vs generic IMAP behavior).
- **Unit:** Command behavior when readonly mode is active (`providerMutation.attempted = false`).
- **Unit:** Partial-failure handling when local archive succeeds and IMAP mutation fails.
- **Integration:** `zmail review dismiss <id>` in readonly mode updates local state only.
- **Integration:** `zmail review dismiss <id>` with mailbox management enabled performs local update plus IMAP archive.
- **Integration:** CLI/MCP JSON output reports provider mutation status clearly.
- **Edge:** Archive target/folder unavailable on provider.
- **Edge:** Re-running archive on an already archived message is idempotent or safely reported.
- **Edge:** Provider disconnect during mutation leaves state understandable and recoverable.

---

## References

- [OPP-032](OPP-032-llm-rules-engine.md) — local inbox triage, dedup, rules, and local archive semantics
- [ADR-005](../ARCHITECTURE.md#adr-005-dual-agent-interface--native-cli--mcp-server) — CLI/MCP agent interfaces
- [ADR-011](../ARCHITECTURE.md#adr-011-email-provider--imap-first-gmail-as-priority-target) — IMAP-first provider model
- [ADR-027](../ARCHITECTURE.md#adr-027-stateful-inbox--no-daemon-soft-state-on-schema-bump) — stateful inbox decisions
