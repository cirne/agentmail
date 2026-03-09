# BUG-008: `zmail who` Case-Sensitive Email Deduplication — Agent-Reported

**Status:** Fixed (Verified 2026-03-07).

**Design lens:** [Agent-first](../VISION.md) — agents need accurate, deduplicated contact data; case-sensitive email addresses create confusion and duplicate entries for the same person.

**Reported context:** Agent on macOS (Darwin 25.3.0); data: 501 emails, 2026-02-28 to 2026-03-07. Reproducibility: Always.

---

## Summary

`zmail who` treats email addresses as case-sensitive, creating duplicate entries for the same person when their email address appears in different cases across messages. Email addresses are case-insensitive per RFC 5321 (the local-part is technically case-sensitive per spec, but virtually no mail server enforces this, and Gmail explicitly ignores case).

---

## What the agent did (and what happened)

1. Ran `zmail who "cirne"` to look up contacts.
2. **Expected:** A single consolidated entry per unique email address (case-insensitive per RFC 5321).
3. **Actual:** Returns separate entries for case variants of the same address:
   ```json
   { "address": "lewiscirne@mac.com", "sentCount": 2, "mentionedCount": 290 },
   { "address": "LEWISCIRNE@MAC.COM", "sentCount": 0, "mentionedCount": 6 },
   { "address": "LewisCirne@mac.com", "sentCount": 0, "mentionedCount": 1 }
   ```
   These are all the same person/address but appear as 3 separate contacts.

---

## Root causes

1. **No normalization at index time:** Email addresses are stored exactly as they appear in message headers, without normalization to lowercase.
2. **No deduplication at query time:** The `who` query doesn't deduplicate addresses by case-insensitive comparison.

---

## Recommendations (concise)

1. **Normalize addresses to lowercase at index time:** Store email addresses in lowercase in the database to ensure consistent deduplication.
2. **Alternative: Deduplicate at query time:** If preserving original case is desired, deduplicate addresses by case-insensitive comparison when aggregating results in `who` queries.

---

## Additional Notes

- Related: `noreply@email.apple.com` shows up as "Kirsten Vliet" because Apple sends shared album notifications using the sharer's display name. This is a harder problem (see feature request for identity merging in [OPP-012](../opportunities/OPP-012-who-smart-address-book.md)).

---

## Verification

- **Status:** Verified
- **Date:** 2026-03-07
- **Result:** Fix confirmed. `zmail who "cirne"` now returns a single Lewis Cirne entry with all 8 addresses merged (including gmail+ variants). No more case-variant duplicates like `LEWISCIRNE@MAC.COM`. All addresses normalized to lowercase.
- **Tested with:** `zmail who "cirne"`

---

## References

- Vision (agent-first): [VISION.md](../VISION.md)
- RFC 5321: Email addresses are case-insensitive
- Related: [OPP-012](../opportunities/OPP-012-who-smart-address-book.md) — Smart Address Book (includes identity merging)
