# BUG-015: Name Inference Produces Garbled `aka` Values for Noreply Addresses — Agent-Reported

**Status:** Fixed (Verified 2026-03-07).

**Design lens:** [Agent-first](../VISION.md) — name inference should not run on noreply/bot addresses; these addresses already have correct display names from headers, and inference produces noise.

**Reported context:** Agent on macOS (Darwin 25.3.0). Reproducibility: Always.

---

## Summary

The name inference feature, when applied to noreply/bot addresses, produces garbled names by incorrectly splitting the email local part. Examples include "Mess Ages-noreply" from `messages-noreply@linkedin.com` and "Noti Fications-noreply" from `notifications-noreply@linkedin.com`.

---

## What the agent did (and what happened)

1. Ran `zmail who "noreply" --all --limit 5` to inspect noreply entries.
2. **Expected:** Noreply/bot addresses should not have inferred names at all. The `aka` field should be empty.
3. **Actual:** Noreply addresses show garbled inferred names in the `aka` field:
   ```json
   { "name": "LinkedIn", "aka": ["Mess Ages-noreply"], "primaryAddress": "messages-noreply@linkedin.com" },
   { "name": "LinkedIn", "aka": ["Noti Fications-noreply"], "primaryAddress": "notifications-noreply@linkedin.com" },
   { "name": "LinkedIn", "aka": ["Upda Tes-noreply"], "primaryAddress": "updates-noreply@linkedin.com" },
   { "name": "NotebookLM", "aka": ["Note Booklm-noreply"], "primaryAddress": "notebooklm-noreply@google.com" },
   { "name": "Receipt Noreply", "aka": [], "primaryAddress": "receipt.noreply@samsungcheckout.com" }
   ```

   Issues:
   - "Mess Ages-noreply", "Noti Fications-noreply", "Upda Tes-noreply" — the camelCase/word-boundary splitter is hallucinating word breaks
   - "Receipt Noreply" is inferred as a person's name from `receipt.noreply@`
   - "Note Booklm-noreply" — incorrectly splitting "notebooklm"

---

## Root causes

1. **Name inference runs on noreply addresses:** The inference logic doesn't check if an address is noreply before attempting to infer a name.
2. **Incorrect splitting patterns:** The inference algorithm tries to split compound words (like "messages", "notifications") as if they were names, producing nonsensical results.
3. **No validation:** Inferred names aren't validated against common noreply patterns or checked for reasonableness.

---

## Recommendations (concise)

1. **Skip name inference for noreply addresses:** Check `isNoreply(address)` before calling `inferNameFromAddress()`.
2. **Skip inference for addresses with "noreply" in local-part:** Even if not caught by `isNoreply()`, addresses with "noreply" or "no-reply" in the local-part should skip inference.
3. **Use display name from headers:** Noreply addresses already have correct display names from email headers (e.g., "LinkedIn"), so inference adds only noise.

---

## Additional Notes

The display name from email headers (e.g., "LinkedIn") is already correct for noreply addresses. The inferred name adds only noise and should be skipped entirely for these addresses.

---

## Verification

- **Status:** Verified
- **Date:** 2026-03-07
- **Result:** Fix confirmed. All garbled `aka` values are gone. LinkedIn entries now show `"aka": []` instead of "Mess Ages-noreply", "Noti Fications-noreply", etc. Name inference is correctly skipped for noreply/bot addresses.
- **Tested with:** `zmail who "noreply" --all --limit 5`

---

## References

- Vision (agent-first): [VISION.md](../VISION.md)
- Related: [OPP-013](../opportunities/OPP-013-who-name-inference-from-address.md) — Name Inference from Address (feature that introduced this issue)
- Related: [BUG-013](BUG-013-who-noreply-display-name-leaks.md) — Noreply addresses leaking through filter
