# BUG-023: Attachments Missing from Synced Email — Agent-Reported

**Status:** Fixed (verified 2026-03-31).

**Design lens:** [Agent-first](../../VISION.md) — attachment extraction is a core workflow (search → find email → read attachments → summarize). When the email body says "attached are the draft documents" but no attachments are available, the agent promises something it can't deliver.

**Reported context:** Agent testing via ztest, 2026-03-09. Email from Donna Wilcox (dwilcox@greenlonghorninc.com), subject "DRAFT Will, DPOA & MPOA - Katelyn", received 2026-03-09T21:27:16Z.

---

## Summary

An email whose body explicitly references attachments ("attached are the draft Will, DPOA & MPOA documents for your review") has zero attachments in the database. The raw EML file **does** contain the attachments (613KB, `multipart/mixed` with 2 PDFs), but they were incorrectly filtered out during parsing.

**Root cause:** The attachment filter in `parse-message.ts` dropped any attachment with `related: true`, even when `disposition === "attachment"`. postal-mime sets `related: true` on attachments in certain multipart structures (e.g., `multipart/mixed` containing `multipart/alternative`), causing real user-facing attachments to be filtered as if they were embedded HTML images.

---

## What the agent did (and what happened)

1. Agent searched for the email — found it, `attachments: []` in results.
2. Agent called `list_attachments` — returned `[]`.
3. Agent told user about the email and its referenced attachments, but couldn't deliver the actual documents.

---

## Root cause (corrected)

The synced message **does** contain the attachments — the EML is 613KB with a proper `multipart/mixed` structure and 2 PDF attachments (`CIRNE L_K - Katelyn's Will.pdf` and `CIRNE L_K - Katelyn's 2026 ancillaries.pdf`). postal-mime correctly parsed them, setting `disposition: "attachment"` and `related: true` (due to the nested `multipart/alternative` structure).

**The bug:** In [`src/sync/parse-message.ts`](src/sync/parse-message.ts) line 56, the filter was:

```typescript
if (att.disposition === "inline" || att.related) {
```

This dropped **any** attachment with `related: true`, even when `disposition === "attachment"`. The filter was intended to exclude embedded HTML images (which have `related: true` and no explicit `disposition: "attachment"`), but it was too aggressive.

**Impact:** 14 attachments across 6 messages were incorrectly filtered, including invoices, legal documents, and presentation files. Superhuman (the user's email client) correctly showed these as attachments, but zmail filtered them out.

---

## Fix

**Fixed in:** Schema version 8 (2026-03-09)

Changed the filter condition from:
```typescript
if (att.disposition === "inline" || att.related) {
```

to:
```typescript
if (att.disposition === "inline" || (att.related && att.disposition !== "attachment")) {
```

This preserves the inline image filter while allowing attachments with explicit `disposition: "attachment"` to pass through, regardless of postal-mime's `related` flag.

**Verification:** After schema bump and rebuild, all 14 previously-dropped attachments are now indexed.

**User verification (2026-03-31):** Confirmed fixed during follow-up verification; bug closed out.

---

## Original implementation plan (superseded)

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
