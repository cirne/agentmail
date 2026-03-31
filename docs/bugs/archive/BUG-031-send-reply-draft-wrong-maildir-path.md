# BUG-031: `zmail send <draft-id>` fails for reply drafts due to wrong maildir path

**Status:** Fixed (verified 2026-03-31). **Created:** 2026-03-31. **Tags:** send, draft, reply, threading, rust, agent-first

**Design lens:** [Agent-first](../../VISION.md) — the `draft reply -> send` path is a core outbound loop. If `zmail send <draft-id>` cannot locate the source message for threading, agents lose the reliable reply flow and fall back to manual sends that break thread continuity.

---

## Summary

- **Observed:** `zmail draft reply` succeeds, but `zmail send <draft-id>` fails when building `In-Reply-To` / `References`.
- **Error:** `Cannot build reply threading: could not read source message at .../.zmail/data/cur/... .eml (No such file or directory)`
- **Expected:** Reply drafts should load the original message from the synced maildir and send with correct threading headers.
- **Impact:** This blocked reply drafts until path resolution was corrected.

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

**Path originally used by `send`:**

```text
~/.zmail/data/cur/191156__CAHaNNGcX=Zje5gYxqoTgpeSWdJVrAi4BpRWysfP_Hm3YuhYdXw@mail.gmail.com_.eml
```

The `maildir/` segment was missing, so the file lookup failed for legacy `raw_path` rows.

---

## Follow-up verification

- **2026-03-31:** Initial retest still reproduced the old `.../.zmail/data/cur/...eml` failure shape.
- **2026-03-31:** Verified fixed after reinstall/retest. `bug-send-reply-draft-wrong-path.md` is now confirmed resolved.
- **Regression coverage:** Rust has targeted tests for both direct reply-threading lookup and `send_draft_by_id(..., dry_run)` when SQLite stores a legacy `raw_path` like `cur/msg1.eml` but the actual file lives at `data/maildir/cur/msg1.eml`.

---

## Root cause

The reply-send threading path reconstructed the source `.eml` location relative to `data/` instead of the canonical maildir root under `data/maildir/`. Reply drafts depend on that raw source message to build `In-Reply-To` and `References`, so an incorrect base path turned reply send into a hard failure.

A concrete trigger was legacy or inconsistent `messages.raw_path` values in SQLite. New sync writes canonical paths like `maildir/cur/<file>.eml`, but older rows or fixtures may still contain `cur/<file>.eml`. Any send/read path that blindly joins `data_dir + raw_path` recreates the broken `data/cur/...` lookup instead of resolving via `data/maildir/cur/...`.

This is distinct from:

- [BUG-027 archived](BUG-027-rust-draft-cli-errors-and-stdin-hang.md) — missing-draft error messaging / stdin behavior
- [BUG-030 archived](BUG-030-draft-commands-hang-after-edit.md) — lazy DB open to avoid SQLite lock hangs

---

## Resolution

`raw_path` resolution now uses the shared canonical maildir compatibility logic instead of reconstructing reply-threading paths manually. That preserves compatibility with both canonical `maildir/cur/...` rows and legacy `cur/...` rows.

---

## References

- Outbound architecture: [ADR-024](../../ARCHITECTURE.md#adr-024-outbound-email--smtp-send-as-user--local-drafts) in [ARCHITECTURE.md](../../ARCHITECTURE.md)
- Shipped send/draft feature: [OPP-011](../../opportunities/OPP-011-send-email.md)
- Related fixes: [BUG-027 archived](BUG-027-rust-draft-cli-errors-and-stdin-hang.md), [BUG-030 archived](BUG-030-draft-commands-hang-after-edit.md)
