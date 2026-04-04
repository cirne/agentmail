# BUG-033: Raw file/OS errors are not actionable enough for agents

**Status:** Open. **Created:** 2026-03-31. **Tags:** errors, cli, ux, agent-first

**Design lens:** [Agent-first](../VISION.md) — when local cache or maildir files are missing, the CLI should explain the failure in zmail terms and suggest the next command to run. Raw OS errors force agents to guess whether they should sync, retry, normalize an ID, or stop.

---

## Summary

- **Observed:** Commands such as `zmail read` and reply `zmail send <draft-id>` surface raw file-not-found errors or low-level path failures.
- **Expected:** Errors should classify the failure, explain it in domain language ("message not in local cache", "source message missing for reply threading"), and suggest a likely next step such as **`zmail refresh`** (fetch mail into the local index).
- **Impact:** Agents must pattern-match raw stderr strings like `Os { code: 2 }` or embedded `No such file or directory` text, which increases retries and makes recovery logic brittle.

---

## Reported examples

```bash
zmail read "<message-id>"
```

```text
Error: Os { code: 2, kind: NotFound, message: "No such file or directory" }
```

```bash
zmail send re-podcast_l87KX8V2
```

```text
Error: "Cannot build reply threading: could not read source message at /Users/cirne/.zmail/data/cur/... .eml (No such file or directory (os error 2))"
```

The second example also overlaps with [BUG-031](BUG-031-send-reply-draft-wrong-maildir-path.md), but this bug is broader: even when the low-level cause is legitimate, the surfaced error format is not agent-friendly.

---

## Root cause

Several command paths still leak raw `std::io::Error` or path-oriented failures directly to the user instead of mapping them into zmail-specific error categories. Earlier fixes addressed parts of this problem for specific flows, but the handling is still inconsistent across commands:

- [BUG-027 archived](archive/BUG-027-rust-draft-cli-errors-and-stdin-hang.md) improved missing-draft messaging.
- [BUG-029 archived](archive/BUG-029-read-bare-message-id-no-angle-brackets.md) improved ID normalization so some "not found" cases resolve automatically.
- Current read/send paths can still emit low-level missing-file output without a recovery hint.

The result is an uneven error contract: some missing-resource failures are actionable, others still require inference from OS messages.

---

## Skill mitigation assessment

**Published skill mitigation:** **Partial.**

A strong published skill can teach agents likely recovery patterns, such as "if a message appears missing locally, run **`zmail refresh`** and retry," which reduces wasted retries. But the skill cannot make low-level errors self-explanatory or reliably machine-readable; the interface still needs a better error contract.

---

## Recommendations

1. **Implementation:** Introduce a shared error-mapping layer for common local-file failures (`message_not_cached`, `source_message_missing`, `draft_not_found`, etc.).
2. **Interface:** Include a short human-readable suggestion with each mapped error, such as `Run zmail refresh to fetch recent messages`.
3. **Interface:** Where practical, expose a stable machine-readable error code in JSON mode or structured MCP errors, so agents do not rely on string matching.
4. **Implementation:** Add regression tests for representative read/send missing-file scenarios to verify both message text and suggested action.
5. **Skill/docs:** Update the published skill with a small recovery table for common failure classes (`sync`-then-retry, missing draft, malformed ID, etc.) while the interface is being improved.

---

## References

- Related send-path bug: [BUG-031](BUG-031-send-reply-draft-wrong-maildir-path.md)
- Prior draft-specific messaging fix: [BUG-027 archived](archive/BUG-027-rust-draft-cli-errors-and-stdin-hang.md)
- Prior read/thread ID normalization fix: [BUG-029 archived](archive/BUG-029-read-bare-message-id-no-angle-brackets.md)
- Historical agent-friction doc: [BUG-001 archived](archive/BUG-001-attachment-and-read-agent-friction.md)
