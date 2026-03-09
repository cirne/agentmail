# OPP-013: Name Inference from Email Addresses

**Status:** Complete — Heuristic inference works for common patterns; LLM-based inference available via `--enrich` flag for better accuracy.

**Problem:** Many contacts show `name: null` despite inferable names. Contacts with significant interaction history show `name: null` when no display name was found in email headers, but many of these have names clearly embedded in the email address.

**Example:** 
```bash
zmail who "greenlonghorninc.com"
```
Returns entries like:
```json
{ "name": null, "primaryAddress": "alanfinley@greenlonghorninc.com", "receivedCount": 18 }
{ "name": null, "primaryAddress": "sjohnson@greenlonghorninc.com", "receivedCount": 14 }
```

Also:
```json
{ "name": null, "primaryAddress": "lewis.cirne@alum.dartmouth.org", "receivedCount": 33 }
{ "name": null, "primaryAddress": "katelyn.cirne@gmail.com", "receivedCount": 2 }
```

**Implemented solution:** Infer display names from email addresses as a fallback when no header name exists:
- ✅ `lewis.cirne@...` → "Lewis Cirne" — *Heuristic inference (high confidence)*
- ✅ `katelyn_cirne@...` → "Katelyn Cirne" — *Heuristic inference (high confidence)*
- ✅ `alanfinley@...` → "Alan Finley" — *Heuristic inference (medium confidence, requires name ending signal)*
- ✅ `whitneyallen@...` → "Whitney Allen" — *Heuristic inference (medium confidence)*
- ✅ `sjohnson@...` → null (ambiguous) — *Correctly rejected*
- ✅ `fredbrown@...` → null (could be username) — *Correctly rejected*

**Heuristic patterns:** `firstname.lastname`, `firstname_lastname`, camelCase (`lewisCirne`), and all-lowercase with strong signals (name endings, common names, high score).

**LLM-based inference:** Use `--enrich` flag for more accurate name inference via GPT-4.1 nano:
- Handles ambiguous cases better than heuristics
- Can infer company names from domain
- Provides type classification (person/group/company/other)
- Requires `ZMAIL_OPENAI_API_KEY` to be set
- Adds ~1-2s latency per query

**Example with --enrich:**
```bash
zmail who "alanfinley" --enrich
```
Returns more accurate inference, especially for ambiguous cases or when company information is needed.

**Open questions:**
- How to handle ambiguous cases (e.g., `sjohnson` could be "S Johnson" or "Sjohn Son")?
- Should inferred names be used for identity merging, or only for display?
- What confidence threshold should trigger inference vs leaving null?

---

## Impact

- `name: null` makes results harder to scan and match
- `lewis.cirne@alum.dartmouth.org` should merge with Lewis Cirne but can't because it has no name
- For an address-book replacement, unnamed contacts feel like data gaps

---

## Benefits

- Enables identity merging for addresses without display names (fixes [BUG-011](../bugs/archive/BUG-011-who-dartmouth-not-merged.md))
- Improves scanability of `who` results
- Reduces data gaps in the address book experience
- Low effort, high impact improvement

---

## Implementation Notes

- Parse local-part of email address for common name patterns
- Use capitalization heuristics (e.g., `lewis.cirne` → "Lewis Cirne")
- Handle edge cases (single letter prefixes, ambiguous names)
- Add `nameSource` field to distinguish inferred vs header names
- Consider using name inference for identity merging

---

## References

- Vision (agent-first): [VISION.md](../VISION.md)
- Related: [BUG-011](../bugs/archive/BUG-011-who-dartmouth-not-merged.md) — Dartmouth address not merged (would be fixed by this)
- Related: [OPP-012](../opportunities/OPP-012-who-smart-address-book.md) — Smart Address Book (includes identity merging)
