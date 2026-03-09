# BUG-014: Signature Parser Extracts Footer Boilerplate as Title/Company — Agent-Reported

**Status:** Fixed (Verified 2026-03-07).

**Design lens:** [Agent-first](../VISION.md) — signature extraction should return clean, useful contact data; footer boilerplate (copyright notices, addresses, tracking URLs) pollutes the contact information.

**Reported context:** Agent on macOS (Darwin 25.3.0). Reproducibility: Always (any LinkedIn noreply entry).

---

## Summary

The `title` and `company` fields for some contacts contain email footer noise instead of actual contact information. LinkedIn noreply addresses show copyright notices as titles and mailing addresses as company names.

---

## What the agent did (and what happened)

1. Ran `zmail who "noreply" --all` to inspect noreply entries.
2. **Expected:** `title` and `company` fields contain real role/organization data, or null if not found.
3. **Actual:** LinkedIn noreply addresses show:
   ```json
   {
     "title": "(c) 2026 LinkedIn Corporation",
     "company": "1zwnj000 West Maude Avenue, Sunnyvale, CA 94085.",
     "urls": ["https://www.linkedin.com/help/...(tracking URLs)..."]
   }
   ```

   Issues:
   - `title` contains a copyright notice, not a job title
   - `company` contains a street address with a Unicode artifact (`1zwnj000` — likely a `&zwnj;` zero-width non-joiner that wasn't stripped)
   - `urls` array is full of tracking/unsubscribe links, not useful contact URLs

---

## Root causes

1. **No heuristics to reject boilerplate:** The signature parser extracts any text that looks like a title/company without filtering out common footer patterns.
2. **No Unicode normalization:** Zero-width characters and other Unicode artifacts aren't stripped before parsing.
3. **No URL filtering:** All URLs are extracted, including tracking/unsubscribe links.
4. **Noreply addresses still processed:** Signature extraction runs on noreply addresses, which are bots and shouldn't have titles/companies.

---

## Recommendations (concise)

1. **Add heuristics to reject boilerplate:**
   - Reject copyright notices as titles (patterns like `(c)`, `©`, `Copyright`)
   - Reject mailing addresses as company names (patterns like street addresses, ZIP codes)
   - Filter tracking/unsubscribe URLs (patterns like `unsubscribe`, `tracking`, `utm_`)
2. **Unicode normalization:** Strip zero-width characters and normalize Unicode before parsing.
3. **Skip signature extraction for noreply addresses:** If an address is flagged as noreply/bot, skip signature extraction entirely (they're bots, not people with titles).

---

## Additional Notes

The signature parser needs heuristics to reject:
- Copyright notices as titles
- Mailing addresses as company names
- Tracking/unsubscribe URLs as contact URLs
- Any content from noreply senders (they're bots, not people with titles)

---

## Verification

- **Status:** Verified
- **Date:** 2026-03-07
- **Result:** Fix confirmed. LinkedIn noreply entries no longer show copyright notices as `title`, mailing addresses as `company`, or tracking URLs in `urls`. All three fields are now null/empty for these entries.
- **Tested with:** `zmail who "noreply" --all --limit 5`

**Additional improvements (2026-03-07):**
- Standalone company name extraction: Now extracts company names that appear on their own line (e.g., "Green Longhorn Inc.") without requiring a title pattern
- Quoted reply detection: Signature extraction stops at quoted reply patterns (e.g., "On ... wrote:") to prevent false positives
- Better signature selection: Improved logic to find the best signature block when multiple candidates exist
- Verified with real-world signatures: Confirmed working with signatures like "Donna Wilcox / Green Longhorn Inc. / phone" format

---

## References

- Vision (agent-first): [VISION.md](../VISION.md)
- Related: [OPP-012](../opportunities/OPP-012-who-smart-address-book.md) — Smart Address Book (includes signature extraction)
- Related: [BUG-013](BUG-013-who-noreply-display-name-leaks.md) — Noreply addresses leaking through filter
