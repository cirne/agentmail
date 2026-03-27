# OPP-015: Enhanced Signature Extraction for `zmail who`

**Status:** Open. **Note:** Basic signature extraction significantly improved (2026-03-07): standalone company names now extracted, quoted reply detection prevents false positives, better signature block selection.

**Problem:** Current signature extraction in `zmail who` extracts basic fields (phone, title, company, URLs, altEmails) but misses many valuable contact details that are commonly present in email signatures. Agents need richer contact information to answer questions like "what's their mobile number?", "what's their LinkedIn?", "what department are they in?", or "what's their timezone?"

**Example:** A signature like:
```
John Smith
VP of Engineering | Acme Corp
Mobile: (555) 123-4567 | Office: (555) 987-6543
john.smith@acme.com | johnsmith@gmail.com
https://linkedin.com/in/johnsmith | https://github.com/johnsmith
San Francisco, CA (PST)
Engineering Team
```

Currently extracts:
- `phone`: "(555) 123-4567" (first phone only)
- `title`: "VP of Engineering"
- `company`: "Acme Corp"
- `urls`: ["https://linkedin.com/in/johnsmith", "https://github.com/johnsmith"]
- `altEmails`: ["johnsmith@gmail.com"]

Missing:
- Mobile vs office phone distinction
- URL categorization (LinkedIn vs GitHub vs personal website)
- Office location (city/state/timezone)
- Department/team name
- Multiple phone numbers

**Proposed direction:** Enhance signature extraction to capture richer, structured contact information:

### Tier 1: Multiple phone numbers (low effort, high value)

- **Extract all phone numbers** — Currently only extracts first phone number
- **Categorize phone types** — Identify mobile, office, fax, direct line
  - Patterns: "Mobile:", "Cell:", "Office:", "Direct:", "Fax:"
  - Return: `phones: { mobile?: string, office?: string, fax?: string, direct?: string }`
- **Fallback to array** — If no labels found, return array of all numbers: `phones: string[]`

### Tier 2: Categorized URLs (medium effort, high value)

- **Identify URL types** — Categorize URLs by domain/pattern:
  - LinkedIn: `linkedin.com/in/`, `linkedin.com/company/`
  - Twitter/X: `twitter.com/`, `x.com/`
  - GitHub: `github.com/`
  - Personal website: Other domains (filter out tracking URLs)
- **Return structured URLs** — `urls: { linkedin?: string, twitter?: string, github?: string, website?: string }`
- **Keep array fallback** — Also maintain `urls: string[]` for uncategorized URLs

### Tier 3: Additional contact fields (medium effort, medium value)

- **Department/Team** — Extract department or team name
  - Patterns: "Engineering Team", "Sales Department", "Team: Engineering"
- **Office location** — Extract city/state/country (without full street address)
  - Patterns: "San Francisco, CA", "New York, NY (EST)", "London, UK"
  - Return: `location: { city?: string, state?: string, country?: string, timezone?: string }`
- **Pronouns** — Extract pronouns if present
  - Patterns: "(he/him)", "(she/her)", "(they/them)", "Pronouns: they/them"
- **Preferred name** — Extract preferred name or nickname
  - Patterns: "Preferred: John", "Call me: Johnny", "(Johnny)"

### Tier 4: Advanced extraction (higher effort, polish)

- **Multiple titles** — Handle people with multiple roles
  - Patterns: "VP Engineering & Co-Founder", "CEO, Board Member"
- **Company subsidiaries** — Extract parent company vs division
  - Patterns: "Acme Corp (Google)", "Engineering at Meta"
- **Assistant info** — Extract executive assistant contact details
  - Patterns: "Assistant: Jane Doe (jane@acme.com)", "EA: ..."

**Open questions:**
- Should we use LLM-based extraction for better accuracy, or stick with regex patterns?
- How to handle international phone number formats?
- Should location extraction include timezone inference from city/state?
- How to handle signatures with multiple people (team signatures)?

---

## Example: Enhanced Output

```json
{
  "name": "John Smith",
  "phones": {
    "mobile": "+1-555-123-4567",
    "office": "+1-555-987-6543"
  },
  "title": "VP of Engineering",
  "company": "Acme Corp",
  "department": "Engineering Team",
  "location": {
    "city": "San Francisco",
    "state": "CA",
    "timezone": "PST"
  },
  "urls": {
    "linkedin": "https://linkedin.com/in/johnsmith",
    "github": "https://github.com/johnsmith",
    "website": "https://johnsmith.dev"
  },
  "altEmails": ["johnsmith@gmail.com"],
  "pronouns": "he/him"
}
```

---

## Benefits

- Agents can answer "what's their mobile number?" instead of just "what's their phone?"
- URL categorization enables "what's their LinkedIn?" queries
- Department/team info helps with organizational queries
- Location/timezone helps with scheduling and context
- Richer contact data makes `who` a more complete address book

## Agent-Friendliness Impact

High. Currently agents get basic contact info but miss structured details that are commonly present in signatures. Enhanced extraction makes `who` more useful for contact lookup, scheduling, and relationship management.

## Alternatives Considered

- External enrichment ([OPP-014 archived](archive/OPP-014-who-external-enrichment-exploration.md)) — Adds dependency, may be stale; signature data is often more current
- Manual contact management — Doesn't scale, goes stale
- Current approach — Missing valuable structured data that's already in signatures

## Implementation Notes

- Tier 1 (multiple phones) is straightforward regex enhancement
- Tier 2 (URL categorization) uses domain matching
- Tier 3 (additional fields) requires pattern matching for various formats
- Tier 4 (advanced) may benefit from LLM extraction for complex cases
- All tiers are independently shippable — each makes `who` better
- Update `ExtractedSignature` interface in `src/search/signature.ts`
- Update `who-dynamic.ts` to use new structured fields

---

## References

- Vision (agent-first): [VISION.md](../VISION.md)
- Related: [OPP-012](OPP-012-who-smart-address-book.md) — Smart Address Book (includes signature extraction)
- Related: [BUG-014](../bugs/archive/BUG-014-who-signature-parser-noise.md) — Signature Parser Noise (boilerplate filtering)
- Related: [OPP-014 archived](archive/OPP-014-who-external-enrichment-exploration.md) — External Enrichment (alternative approach)
