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

## Recommendations (concise)

1. **Attachment reference detection** — when the body text contains phrases like "attached", "see attachment", "enclosed" but `attachments: []`, surface a hint: "This email references attachments that may be on the original/forwarded message." Helps the agent set user expectations.
2. **Thread-aware attachment lookup** — if a message references attachments but has none, check other messages in the same thread (In-Reply-To / References headers) for attachments. The original message may be in the mailbox.
3. **Google Drive link detection** — some forwarded attachments become Drive sharing links in the body. Detect and surface these as "linked attachments."

---

## References

- Vision (agent-first): [VISION.md](../../VISION.md)
- Related: [BUG-021](archive/BUG-021-read-prepare-error.md) — `get_message` also failed for this message (fixed)
- Related: [BUG-001](archive/BUG-001-attachment-and-read-agent-friction.md) — earlier attachment friction (fixed)
