# BUG-012: `--min-sent` Filter Splits Merged Identities — Agent-Reported

**Status:** Fixed (Verified 2026-03-07).

**Design lens:** [Agent-first](../VISION.md) — filters should apply to merged identity aggregates, not individual addresses before merging; splitting identities breaks the unified address book experience.

**Reported context:** Agent on macOS (Darwin 25.3.0). Reproducibility: Always.

---

## Summary

Using `--min-sent` (or `--min-received`) causes identity merging to break, returning partial identity fragments. The filter appears to run before identity merging, so addresses that individually fall below the threshold are dropped, splitting the merged person.

---

## What the agent did (and what happened)

1. Ran `zmail who "matt shandera"` without filter:
   - **Result:** Matt Shandera has `matt@gamaliel.ai` + `mshandera@gamaliel.ai` merged (sentCount: 4).

2. Ran `zmail who "matt" --min-sent 3`:
   - **Expected:** Filters should apply to the merged identity's aggregate counts (sentCount: 4), so the merged person should still be returned.
   - **Actual:** Only `mshandera@gamaliel.ai` returned (sentCount: 3), `matt@gamaliel.ai` dropped (sentCount: 1, below threshold).

---

## Root causes

1. **Filter applied before merging:** The `--min-sent` and `--min-received` filters are applied to individual addresses before identity clustering/merging occurs.
2. **Aggregate counts not considered:** The filter doesn't check the merged identity's aggregate counts (sum of all addresses' counts).

---

## Recommendations (concise)

1. **Merge first, then filter:** Apply identity clustering and merging first, aggregate counts per merged identity, then apply filters to the merged identity's aggregate counts.
2. **Filter logic:** `WHERE (sent_count + received_count) >= minThreshold` should be evaluated on the merged identity, not individual addresses.

---

## Additional Notes

This affects any filter flag (`--min-sent`, `--min-received`). The fix is to merge first, aggregate counts, then filter.

---

## Verification

- **Status:** Verified
- **Date:** 2026-03-07
- **Result:** Fix confirmed. `zmail who "matt" --min-sent 3` now returns Matt Shandera with both addresses merged (matt@gamaliel.ai + mshandera@gamaliel.ai, sentCount: 4). The filter now applies after identity merging, not before.
- **Tested with:** `zmail who "matt" --min-sent 3`, `zmail who "matt shandera"`

---

## References

- Vision (agent-first): [VISION.md](../VISION.md)
- Related: [OPP-012](../opportunities/OPP-012-who-smart-address-book.md) — Smart Address Book (includes identity merging)
