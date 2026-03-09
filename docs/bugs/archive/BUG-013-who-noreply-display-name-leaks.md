# BUG-013: Noreply Addresses Leak Through Filter When Display Name Matches Query — Agent-Reported

**Status:** Fixed (Verified 2026-03-07).

**Design lens:** [Agent-first](../VISION.md) — noreply addresses should be filtered by default; display name matching shouldn't bypass the noreply filter.

**Reported context:** Agent on macOS (Darwin 25.3.0). Reproducibility: Always.

---

## Summary

Searching for a person by name returns noreply addresses that happen to have that person's name in the display name field, even without `--all`. The noreply filter correctly hides most bot addresses, but the name-match path bypasses it.

---

## What the agent did (and what happened)

1. Ran `zmail who "matt shandera"` (without `--all` flag).
2. **Expected:** Only real person entries returned. Noreply addresses filtered unless `--all` is passed.
3. **Actual:** Returns `drive-shares-dm-noreply@google.com` as a separate person because its display name is "Matt Shandera (via Google Docs)". This is a noreply address and should be filtered by default.
   ```json
   {
     "name": "Matt Shandera (via Google Docs)",
     "primaryAddress": "drive-shares-dm-noreply@google.com",
     "sentCount": 1,
     "receivedCount": 0
   }
   ```

---

## Root causes

1. **Filter order:** The noreply filter is applied before name matching, so addresses that match the query by display name are included even if they're noreply addresses.
2. **Name-match bypass:** The name-match path doesn't re-check noreply status after matching.

---

## Recommendations (concise)

1. **Apply noreply filter after name matching:** Check noreply status after all matching logic, ensuring noreply addresses are filtered even if they match by display name.
2. **Filter logic:** `if (!includeNoreply && cluster.isNoreply) continue;` should be evaluated after all clustering and matching, not before.

---

## Additional Notes

The noreply filter correctly identifies `drive-shares-dm-noreply@google.com` as noreply, but the filter is bypassed when the display name matches the query.

---

## Verification

- **Status:** Verified
- **Date:** 2026-03-07
- **Result:** Fix confirmed. `zmail who "matt shandera"` now returns only the real Matt Shandera entry. The `drive-shares-dm-noreply@google.com` address no longer leaks through the noreply filter.
- **Tested with:** `zmail who "matt shandera"`

---

## References

- Vision (agent-first): [VISION.md](../VISION.md)
- Related: [OPP-012](../opportunities/OPP-012-who-smart-address-book.md) — Smart Address Book (includes noreply filtering)
