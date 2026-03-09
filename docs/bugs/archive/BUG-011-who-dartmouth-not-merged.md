# BUG-011: `lewis.cirne@alum.dartmouth.org` Not Merged with Lewis Cirne Identity — Agent-Reported

**Status:** Fixed (Verified 2026-03-07).

**Design lens:** [Agent-first](../VISION.md) — agents need accurate, unified contact data; identity merging should handle local-part variations (dots, underscores) to merge addresses that clearly belong to the same person.

**Reported context:** Agent on macOS (Darwin 25.3.0). Reproducibility: Always.

---

## Summary

The identity merger correctly groups 7 Lewis Cirne addresses but misses the Dartmouth alumni address `lewis.cirne@alum.dartmouth.org`. The local part `lewis.cirne` matches `lewiscirne` if you ignore the dot separator, but the current clustering logic doesn't handle this variation.

---

## What the agent did (and what happened)

1. Ran `zmail who "cirne"` to look up contacts.
2. **Expected:** `lewis.cirne@alum.dartmouth.org` merged into the Lewis Cirne identity (which already has lewiscirne@gmail.com, @mac.com, @icloud.com, @me.com, and 3 gmail+ variants).
3. **Actual:** Shows as a separate entry with `name: null` and 33 received emails:
   ```json
   {
     "name": null,
     "primaryAddress": "lewis.cirne@alum.dartmouth.org",
     "addresses": ["lewis.cirne@alum.dartmouth.org"],
     "receivedCount": 33
   }
   ```

---

## Root causes

1. **No name-based merge:** The address has no display name (`name: null`), so name-based clustering can't merge it.
2. **Local-part normalization insufficient:** Current normalization strips dots from local-parts for consumer domains (gmail.com, etc.) but doesn't apply fuzzy matching for non-consumer domains like `alum.dartmouth.org`.
3. **Missing name inference:** Without a display name, the system can't infer "Lewis Cirne" from `lewis.cirne@alum.dartmouth.org` to enable name-based merging.

---

## Recommendations (concise)

1. **Name inference from address:** Infer display names from email addresses as a fallback when no header name exists (e.g., `lewis.cirne@...` → "Lewis Cirne"). This would enable name-based merging.
2. **Local-part fuzzy matching:** Apply local-part normalization (strip dots/underscores, compare) as an additional merge signal, even for non-consumer domains.
3. **Both approaches:** Combine name inference with local-part fuzzy matching for robust identity merging.

---

## Additional Notes

Same issue applies to `katelyn.cirne@gmail.com` and `katelyn_cirne@icloud.com` — clearly the same person but both have `name: null` so can't merge by name.

---

## Verification

- **Status:** Verified
- **Date:** 2026-03-07
- **Result:** Fix confirmed. `lewis.cirne@alum.dartmouth.org` is now merged into the Lewis Cirne identity (8 addresses total). Additionally, `katelyn.cirne@gmail.com` and `katelyn_cirne@icloud.com` are now merged into a single "Katelyn Cirne" entry with inferred name. Both issues from this report are resolved.
- **Tested with:** `zmail who "cirne"`, `zmail who "katelyn"`

---

## References

- Vision (agent-first): [VISION.md](../VISION.md)
- Related: [OPP-013](../opportunities/OPP-013-who-name-inference-from-address.md) — Name Inference from Address (fixes this)
- Related: [OPP-012](../opportunities/OPP-012-who-smart-address-book.md) — Smart Address Book (includes identity merging)
