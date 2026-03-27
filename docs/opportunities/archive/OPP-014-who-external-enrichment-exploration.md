# OPP-014: External Enrichment for `zmail who` — Exploration

**Archived:** 2026-03-26 — **exploration complete** (findings retained). Exa `--enrich` behavior and limitations are documented below; follow-on provider work (e.g. Tavily) belongs under [OPP-012](../OPP-012-who-smart-address-book.md) / [OPP-015](../OPP-015-who-enhanced-signature-extraction.md) if prioritized.

**Status (historical):** Exploration — Exa tested, accuracy insufficient. Alternatives evaluated.

**Problem:** `zmail who` extracts contact info from email signatures (title, company, phone, URLs), but this data is often missing or stale. External enrichment could add current LinkedIn/Twitter/GitHub profiles and up-to-date professional information, making `who` a more complete address book.

**Example:** `zmail who "cirne" --enrich` should return:
```json
{
  "name": "Lewis Cirne",
  "linkedin": "https://www.linkedin.com/in/lewis-cirne-57269226a/",
  "twitter": "https://twitter.com/lewiscirne",
  "github": "https://github.com/lewiscirne",
  "title": "Founder and CEO",  // Current, from LinkedIn
  "company": "The Gamaliel Project"  // Current, from LinkedIn
}
```

**Exploration:** Tested Exa API for person enrichment with `--enrich` flag.

## Exa API Testing Results

**Implementation:** Added `--enrich` flag to `zmail who` that:
- Fires parallel Exa searches (person + company) for top 3 results
- Uses `category: "people"` for LinkedIn/Twitter/GitHub links
- Uses regular search for company descriptions
- Caches results in SQLite (30-day TTL)

**Findings:**

1. **Exa `category: "people"` is unreliable for exact person matching**
   - Query: `"Lewis Cirne LinkedIn"` → Returns `lisa-cirne-81763b2` (wrong person)
   - Query: `"Lewis Cirne"` → Returns various "Cirne" people but not Lewis
   - Query: `"Lewis Cirne New Relic"` → Returns New Relic employees but not Lewis
   - **Root cause:** Exa's neural search matches by semantic similarity (last name "Cirne") rather than exact name matching

2. **Removing `category: "people"` improves results slightly**
   - Without category: Finds `lewcirne` (likely Lewis Cirne, nickname)
   - Still not finding the exact profile URL: `lewis-cirne-57269226a`

3. **Exa's value proposition doesn't match this use case**
   - Exa excels at semantic search: "companies working on AI for finance" → relevant company pages
   - Exa struggles with exact lookups: "find Lewis Cirne's LinkedIn" → wrong people with same last name
   - Designed for AI agents doing research, not precise person lookups

## Alternative Services Evaluated

### Tavily
- **Pros:** Free tier (1,000 credits/month), designed for LinkedIn search, JavaScript SDK
- **Cons:** Still requires API key (though free)
- **Status:** Not tested, but promising alternative

### OpenAI Web Search
- **Pros:** Can reuse existing `OPENAI_API_KEY`
- **Cons:** Integrated into chat models (Responses API), not standalone search API
- **Status:** Not ideal for simple search use case

### Free Options (No API Key)
- **DuckDuckGo HTML scraping:** Unreliable, fragile to HTML changes
- **SearXNG:** Public instances often disable JSON API
- **Direct LinkedIn scraping:** Fragile, violates ToS

## Current Implementation Status

**Shipped:** `--enrich` flag with Exa integration (prototype)
- ✅ Exa client wrapper (`src/lib/exa.ts`)
- ✅ Enrichment logic with caching (`src/search/who-enrich.ts`)
- ✅ CLI flags (`--enrich`, `--no-cache`)
- ✅ Cache hint when enrichment uses cached data

**Known Issues:**
- ❌ Returns wrong LinkedIn profiles (e.g., Lisa Cirne instead of Lewis Cirne)
- ❌ Accuracy insufficient for production use
- ❌ No validation to filter incorrect matches

## Proposed Direction

**Option 1: Switch to Tavily** (recommended if proceeding)
- Free tier available (1,000 credits/month)
- Designed specifically for LinkedIn profile search
- Better accuracy expected based on documentation
- Requires API key but free tier is generous

**Option 2: Skip external enrichment** (recommended for now)
- Current signature extraction already provides title/company/phone/URLs
- Signature data is often more current than LinkedIn profiles
- Avoids API dependency and accuracy issues
- Keep `--enrich` as experimental/optional feature

**Option 3: Add validation layer**
- Only accept LinkedIn URLs where URL slug or title contains first name
- Filter out wrong matches (e.g., reject "lisa-cirne" for "Lewis Cirne")
- Still may miss correct profiles if Exa doesn't return them

## Open Questions

- Is external enrichment worth the complexity if accuracy is unreliable?
- Should we require API keys for optional features, or keep zmail dependency-free?
- Would Tavily perform better, or is exact person lookup fundamentally hard for semantic search?
- Should enrichment be opt-in only, with clear warnings about accuracy?

## Impact

**If successful:**
- Agents get current LinkedIn/Twitter/GitHub links for contacts
- More complete address book experience
- Enables follow-up research (e.g., "find their LinkedIn posts")

**Current reality:**
- Exa returns wrong profiles too often
- Signature extraction is more reliable for title/company
- External enrichment adds complexity without clear benefit

## Implementation Notes

- Exa integration is complete but not production-ready
- Cache system works well (30-day TTL, SQLite storage)
- Parallel search architecture (person + company) is sound
- Main issue is search accuracy, not implementation

## References

- Related: [OPP-012](../OPP-012-who-smart-address-book.md) — Smart Address Book (includes signature extraction)
- Exa docs: https://docs.exa.ai/reference/search
- Tavily docs: https://docs.tavily.com/examples/quick-tutorials/linkedin-profile-search
