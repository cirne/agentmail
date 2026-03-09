# BUG-023: Attachments Missing from Synced Email — Agent-Reported

**Status:** Open.

**Design lens:** [Agent-first](../../VISION.md) — attachment extraction is a core workflow (search → find email → read attachments → summarize). When the email body says "attached are the draft documents" but no attachments are available, the agent promises something it can't deliver.

**Reported context:** Agent testing via ztest, 2026-03-09. Email from Donna Wilcox (dwilcox@greenlonghorninc.com), subject "DRAFT Will, DPOA & MPOA - Katelyn", received 2026-03-09T21:27:16Z.

---

## Summary

An email whose body explicitly references attachments ("attached are the draft Will, DPOA & MPOA documents for your review") has zero attachments in the database. The raw EML file on disk also has no multipart structure and no `Content-Disposition: attachment` headers — the attachment data was never received via IMAP.

This means the issue is upstream of zmail's attachment parser: the synced message simply doesn't contain attachment MIME parts.

---

## What the agent did (and what happened)

1. Agent searched for the email — found it, `attachments: []` in results.
2. Agent called `list_attachments` — returned `[]`.
3. Agent told user about the email and its referenced attachments, but couldn't deliver the actual documents.

---

## Root cause

The synced message is Donna's **forward** of Mike Baldwin's email. The original email from the attorney contained the attachments (Will, DPOA, MPOA documents), but when Donna forwarded it, Gmail created a new message with the quoted text only — the attachment MIME parts weren't carried over into the forward. The raw EML on disk is `text/plain` with no multipart structure.

This is not a zmail bug — the attachments genuinely aren't in the forwarded message. They exist on the **original** message (from mbaldwin@jw.com), which may or may not be in the user's mailbox depending on whether they were CC'd or the original was shared separately.

**Agent-side gap:** The `ask` pipeline has no way to distinguish "email has no attachments" from "email body references attachments that live on a different message." The body says "attached are the draft documents" but `attachments: []` — the agent tells the user about attachments it can't deliver.

---

## Implementation plan

### Step 1 — Detect phantom attachments at context assembly time

In `src/ask/agent.ts` `assembleContext()`, after fetching a message and finding `attachments.length === 0`, scan the body text for attachment-referencing language. If found, append a hint to the message context.

```
Location: src/ask/agent.ts, assembleContext() — after the attachment processing block (~line 166)
```

**Detection heuristic** — simple keyword scan on `body_text`:
- Match phrases: `attached`, `see attached`, `see the attached`, `please find attached`, `enclosed`, `I've attached`, `I have attached`, `attaching`, `the attachment`
- Only trigger when `attachments.length === 0` for that message
- Append to the message context block: `\n[Note: This email references attachments in its body text but none were found. The attachments may be on the original/forwarded message or shared via a link.]`

This gives Mini (the synthesis model) the information it needs to set expectations in the answer rather than promising attachments it can't deliver.

**Where to put the helper:** Create a small utility function `detectPhantomAttachments(bodyText: string): boolean` in `src/ask/tools.ts` (or inline in `assembleContext`). Keep it simple — no NLP, just substring matching.

### Step 2 — Surface phantom hint in MCP/CLI too

In `src/messages/lean-shape.ts` or `src/messages/presenter.ts`, when formatting a message for `get_message` / `read` output:
- If `attachments: []` and body references attachments → add a `phantomAttachments: true` flag or a `hint` field
- MCP `get_message` and CLI `read` output the hint so agents outside of `ask` also benefit

This makes the hint available to any agent using the MCP or CLI, not just the ask pipeline.

### Step 3 (future) — Google Drive link detection

Scan body text for Google Drive sharing URLs (`drive.google.com/file`, `docs.google.com`, `drive.google.com/open`). When found and `attachments: []`, surface them as linked attachments in the output. Lower priority — Drive links are rarer than stripped-forward attachments.

### Scope and constraints

- **No threading required.** This fix works per-message, no cross-thread lookup needed. Thread-aware attachment fallback is a separate, larger effort.
- **No false positive risk.** The hint only appears when body says "attached" but attachment list is empty — worst case, the email genuinely has no attachments and just uses "attached" loosely (rare; low cost if it happens).
- **Minimal code change.** Step 1 is ~15 lines in `assembleContext`. Step 2 is ~10 lines in the presenter. No schema change, no new dependencies.

---

## References

- Vision (agent-first): [VISION.md](../../VISION.md)
- Related: [BUG-021](archive/BUG-021-read-prepare-error.md) — `get_message` also failed for this message (fixed)
- Related: [BUG-001](archive/BUG-001-attachment-and-read-agent-friction.md) — earlier attachment friction (fixed)
