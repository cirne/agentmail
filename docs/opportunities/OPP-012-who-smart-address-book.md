# OPP-012: Make `zmail who` a Smart, Unified Address Book

**Status:** Partial — Tiers 1-2 complete, Tier 3 mostly complete (signature extraction robust), Tier 4 remaining.

**Problem:** As an agent, `zmail who` is my only way to answer "who is this person?" or "how do I reach them?" Right now it returns raw per-address rows with no identity merging, no contact metadata, and no way to distinguish a real person from a noreply address. For `who` to become a true address book — the agent's de facto contact lookup — it needs to evolve significantly.

**Example:** `zmail who "cirne"` returns 8 separate rows for what is clearly one person across `@gmail.com`, `@mac.com`, `@icloud.com`, `@me.com`, `@alum.dartmouth.org`. `noreply@email.apple.com` shows up as "Kirsten Vliet" because Apple sends notifications using the sharer's display name. Automated senders pollute the people index.

**Proposed direction:** Evolve `zmail who` into an identity-aware contact graph with multiple tiers of enhancement:

### Tier 1: Core fixes (low effort, high impact) ✅ **COMPLETE**

- ✅ **Case-insensitive dedup** — Normalize email addresses to lowercase at index time (addresses [BUG-008](../bugs/archive/BUG-008-who-case-sensitive-email-dedup.md))
- ✅ **Filter noreply/automated senders** — Flag or deprioritize addresses matching `noreply@`, `no-reply@`, `mailer-daemon@`, etc. (addresses [BUG-013](../bugs/archive/BUG-013-who-noreply-display-name-leaks.md))
- ✅ **Add `lastContact` timestamp** — When was the last email to/from this person?
- ⚠️ **Add `relationship` score** — Simple heuristic: `sentCount * 3 + receivedCount * 2 + mentionedCount` (weighting direct communication higher) — *Not yet implemented*

### Tier 2: Identity merging (medium effort, high impact) ✅ **COMPLETE**

- ✅ **Auto-merge by name** — When two addresses share the same `displayName` (exact or fuzzy match) and aren't noreply addresses, link them as the same person
- ✅ **AKA field** — `"aka": ["Kirsten Cirne", "Kirsten Vliet"]` — track all display names seen for a person
- ⚠️ **Domain grouping** — Show which organizations a person is associated with: `"orgs": ["greenlonghorninc.com", "gmail.com"]` — *Not yet implemented*
- ⚠️ **Manual merge/split** — `zmail who merge <addr1> <addr2>` and `zmail who split <addr>` for corrections — *Not yet implemented*

### Tier 3: Signature extraction (medium effort, high value) ✅ **MOSTLY COMPLETE**

- ✅ **Phone numbers** — Parse email signatures for phone numbers: `"phone": "+1-555-123-4567"` — *Implemented and verified*
- ✅ **Title / role** — Extract from signatures: `"title": "CEO, Green Longhorn Inc."` — *Implemented with boilerplate filtering* (addresses [BUG-014](../bugs/archive/BUG-014-who-signature-parser-noise.md))
- ✅ **Company** — From signature or domain: `"company": "Green Longhorn Inc."` — *Implemented with boilerplate filtering and standalone company name detection* (verified 2026-03-07)
- ✅ **Social links** — LinkedIn, Twitter URLs from signatures — *Implemented with tracking URL filtering*
- ✅ **Quoted reply detection** — Signature extraction stops at quoted reply patterns (e.g., "On ... wrote:") to avoid false positives — *Implemented and verified*

### Tier 4: Smart queries (lower priority, polishes the experience)

- **`zmail who "sterling" --full`** — Show all merged identities, all known addresses, extracted contact info
- **`zmail who --top 20`** — Top contacts by relationship score
- **`zmail who --recent`** — Recently active contacts
- **`zmail who "company:gamaliel"`** — Search by organization/domain
- **`zmail who --groups`** — Cluster contacts by domain/organization

**Open questions:**
- Should identity merging be automatic (by name matching) or require manual confirmation?
- How to handle false positives in name-based merging (e.g., two different "John Smith" people)?
- Should signature extraction use regex patterns or LLM-based extraction for better accuracy?
- Should `who` become a full contact management system, or remain focused on email-derived data?

---

## Example: Ideal Output

```bash
$ zmail who "cirne"
```

```json
{
  "query": "cirne",
  "people": [
    {
      "name": "Lewis Cirne",
      "aka": ["Lew Cirne", "Lewis Cirne"],
      "primaryAddress": "lewiscirne@gmail.com",
      "addresses": [
        "lewiscirne@gmail.com",
        "lewiscirne@mac.com",
        "lewiscirne@icloud.com",
        "lewiscirne@me.com",
        "lewis.cirne@alum.dartmouth.org"
      ],
      "phone": ["+1-555-123-4567"],
      "title": "Founder",
      "company": "Green Longhorn Inc.",
      "sentCount": 2,
      "receivedCount": 10,
      "mentionedCount": 290,
      "relationshipScore": 0.95,
      "lastContact": "2026-03-07T14:30:00Z"
    },
    {
      "name": "Kirsten Vliet",
      "aka": ["Kirsten Cirne"],
      "primaryAddress": "kirstencirne@mac.com",
      "addresses": ["kirstencirne@mac.com"],
      "sentCount": 1,
      "receivedCount": 18,
      "mentionedCount": 4,
      "relationshipScore": 0.72,
      "lastContact": "2026-02-28T23:43:38Z"
    }
  ]
}
```

Note: `noreply@email.apple.com` no longer pollutes Kirsten's results. All of Lewis's address variants are merged into one identity.

---

## Benefits

- Agents can answer "what's Sterling's phone number?" or "what company does Matt work for?" in one call
- No more guessing which of 8 email addresses is the right one to reference
- Relationship scoring lets agents prioritize important contacts
- Becomes the single source of truth for "who is this person?" across all agent workflows

## Agent-Friendliness Impact

Massive. Currently, an agent doing any people-related task (draft an email, find a contact, summarize a relationship) has to do multiple `who` queries, manually deduplicate, and still can't get phone/title/company data. A smart `who` collapses that to a single call.

## Alternatives Considered

- External contacts API (Google Contacts, etc.) — adds dependency, doesn't capture email-only contacts
- Manual address book file — doesn't scale, goes stale
- Current approach + agent-side dedup — wastes tokens and is fragile

## Implementation Notes

- Tier 1 (case normalization, noreply filter, lastContact, score) is likely a few hours of work
- Tier 2 (identity merging) needs a `people` or `identities` table linking addresses to a canonical person
- Tier 3 (signature parsing) can start simple with regex, improve over time with LLM extraction
- All tiers are independently shippable — each one makes `who` meaningfully better

---

## References

- Vision (agent-first): [VISION.md](../VISION.md)
- Related: [BUG-008](../bugs/archive/BUG-008-who-case-sensitive-email-dedup.md) — Case-sensitive email dedup (Tier 1)
- Related: [OPP-004](../opportunities/archive/OPP-004-people-index-contacts.md) — People Index and Contacts (basic `who` implemented)
