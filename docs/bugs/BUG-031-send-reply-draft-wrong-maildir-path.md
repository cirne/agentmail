# BUG-031: `zmail send <draft-id>` fails for reply drafts due to wrong maildir path

**Status:** Open. **Created:** 2026-03-31. **Tags:** send, draft, reply, threading, rust, agent-first

**Design lens:** [Agent-first](../VISION.md) — the `draft reply -> send` path is a core outbound loop. If `zmail send <draft-id>` cannot locate the source message for threading, agents lose the reliable reply flow and fall back to manual sends that break thread continuity.

---

## Summary

- **Observed:** `zmail draft reply` succeeds, but `zmail send <draft-id>` fails when building `In-Reply-To` / `References`.
- **Error:** `Cannot build reply threading: could not read source message at .../.zmail/data/cur/... .eml (No such file or directory)`
- **Expected:** Reply drafts should load the original message from the synced maildir and send with correct threading headers.
- **Impact:** This is a blocking bug for reply drafts. The documented workaround is to send manually with flags, but that loses proper reply threading.

---

## Reported reproduction

```bash
zmail search --from "stiller" --text "title" --limit 5
zmail draft reply --message-id "<...>" --body "test reply"
zmail send re-podcast_l87KX8V2
```

**Actual source message path on disk:**

```text
~/.zmail/data/maildir/cur/191156__CAHaNNGcX=Zje5gYxqoTgpeSWdJVrAi4BpRWysfP_Hm3YuhYdXw@mail.gmail.com_.eml
```

**Path used by `send`:**

```text
~/.zmail/data/cur/191156__CAHaNNGcX=Zje5gYxqoTgpeSWdJVrAi4BpRWysfP_Hm3YuhYdXw@mail.gmail.com_.eml
```

The `maildir/` segment is missing, so the file lookup always fails.

---

## Root cause

The reply-send threading path appears to reconstruct the source `.eml` location relative to `data/` instead of the canonical maildir root under `data/maildir/`. Reply drafts depend on that raw source message to build `In-Reply-To` and `References`, so an incorrect base path turns every reply send into a hard failure.

This is distinct from:

- [BUG-027 archived](archive/BUG-027-rust-draft-cli-errors-and-stdin-hang.md) — missing-draft error messaging / stdin behavior
- [BUG-030 archived](archive/BUG-030-draft-commands-hang-after-edit.md) — lazy DB open to avoid SQLite lock hangs

Those fixes made draft commands more reliable, but did not validate that reply sends resolve the raw message path correctly.

---

## Skill mitigation assessment

**Published skill mitigation:** **Low.**

A strong published skill can steer agents toward the intended `draft reply -> send` workflow and can mention a temporary workaround for broken reply sends, but it cannot prevent this failure once the agent follows the correct path. This is primarily an interface/implementation bug, not an instruction gap.

---

## Recommendations

1. **Implementation:** Use the same canonical maildir path resolution for reply-send threading that sync/rebuild/read use, rather than reconstructing `data/cur/...` manually.
2. **Implementation:** Add a regression test covering `draft reply` followed by `send <draft-id>` where the source message lives under `data/maildir/cur/`.
3. **Interface:** Treat missing source-message files as a first-class send error with both the attempted path and guidance about maildir expectations, so future path regressions are easier to diagnose.
4. **Skill/docs:** In the published skill, note that reply-send should preserve threading and that agents should prefer the draft-based reply flow over manual `send --to/--subject` fallbacks except as an explicit temporary workaround.

---

## References

- Outbound architecture: [ADR-024](../ARCHITECTURE.md#adr-024-outbound-email--smtp-send-as-user--local-drafts) in [ARCHITECTURE.md](../ARCHITECTURE.md)
- Shipped send/draft feature: [OPP-011](../opportunities/OPP-011-send-email.md)
- Related fixes: [BUG-027 archived](archive/BUG-027-rust-draft-cli-errors-and-stdin-hang.md), [BUG-030 archived](archive/BUG-030-draft-commands-hang-after-edit.md)
