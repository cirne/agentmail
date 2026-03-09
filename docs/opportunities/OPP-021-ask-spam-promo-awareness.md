# OPP-021: Ask / Search — Spam and Promotional Signal Awareness

**Problem:** The answer engine and search do not account for spam or promotional indicators. Queries that imply "real" or "recent" mail can be dominated by marketing, offers, newsletters, and bulk mail, so answers and result sets are noisier than users expect.

**Examples (illustrative; the fix should be generalized, not hard-coded for these):**

- A query about "travel" should favor real travel confirmations, itineraries, and personal correspondence over travel deals, airline newsletters, and promo emails.
- A query like "what's most recent" or "what's new in my inbox" should emphasize recent messages that look like personal or transactional mail, not just the chronologically latest batch of promotions.

**Proposed direction:** Make ask (and the search it uses) aware of spam/promotional signals and use them to improve relevance.

- **Option A — Filter:** Exclude (or allow opt-in exclusion of) messages that meet a "promotional/bulk" criterion so that "what's new" and topic queries operate over a cleaner set. Simpler to implement and reason about; one clear predicate.
- **Option B — Ranking:** Use the same signals as a ranking factor so that real mail ranks higher but marketing can still appear if it matches. More nuanced but adds scoring complexity and tuning.

Recommendation: start with **filter** (e.g. a search/ask option like "exclude promotional" or "personal/transactional only") so behavior is predictable and implementation is straightforward. Ranking can be explored later if users want promotional results sometimes.

**Signals to consider:**

- **Labels (when present):** e.g. Gmail `Promotions`, `Social`, `Forums`, or provider-specific "spam"/"bulk" labels. Already in `messages.labels`; can filter or down-rank by label. Note: We exclude "Updates" category as it contains important transactional emails.
- **List / bulk headers:** e.g. `List-Unsubscribe`, `List-Id`, `Precedence: auto|list|junk`, `X-Auto-Response-Suppress`. Could be stored at index time (new column or JSON) and used in filter/ranking.
- **Heuristics:** Sender domain or subject patterns (e.g. "Unsubscribe", "Manage preferences", "%%") as a fallback when headers are missing. Lower priority to avoid false positives.

**Scope:**

- **Ask:** When the intent implies "recent" or "what matters" (e.g. "what's new", "latest", "recent"), apply the filter (or ranking) so results are biased toward non-promotional mail. Same for topic queries where the intent is transactional or personal (e.g. travel confirmations vs travel ads).
- **Search:** Expose the same capability so that CLI and MCP search can optionally restrict to "personal/transactional" or "exclude promotional" for consistency with ask.

**Open questions:**

- Filter vs ranking: filter is easier and clearer; document the choice in this OPP and in ARCHITECTURE if we add a new search parameter.
- Where to store list/promotion signal: new column (e.g. `is_promotional INTEGER`) vs parsing headers at query time. Column is better for performance and reuse; requires index-time logic and schema change (manual ALTER per AGENTS.md).
- Default: should "exclude promotional" be the default for `zmail ask` or only when the query implies recency/relevance? Default-on for ask may be best; keep raw search unchanged unless a flag is passed.

---

## Implementation Plan

### Decision log

- **Filter, not ranking.** Predictable and easy to reason about. Ranking can come later if users want promotional results sometimes.
- **`is_noise` column.** Computed at sync time from headers and labels; stored for fast, zero-cost filtering at query time. Detects promotional, social, forums, bulk, and spam messages (Gmail categories: Promotions, Social, Forums, Spam). Excludes "Updates" category as it contains important transactional emails.
- **Default-on for both `ask` and `search`.** Noise messages are excluded by default everywhere. Pass `--include-noise` (CLI) or `includeNoise: true` (API/MCP) to opt back in.
- **Schema bump, not migration.** Bump `SCHEMA_VERSION` to 4; the DB rebuild + resync populates `is_noise` for all messages. No ALTER TABLE, no migration files, consistent with project rules.

### Step 1 — Schema

In `src/db/schema.ts`:
- Bump `SCHEMA_VERSION` to `4`.
- Add `is_noise INTEGER NOT NULL DEFAULT 0` to the `messages` table (after `labels`).
- Add a partial index: `CREATE INDEX IF NOT EXISTS idx_messages_noise ON messages(is_noise) WHERE is_noise = 1;` — accelerates filtering out noise messages.

### Step 2 — Detection at parse time

In `src/sync/parse-message.ts`:
- Add `isNoise: boolean` to the `ParsedMessage` interface.
- After `PostalMime.parse()`, inspect `email.headers` for bulk/list signals. Mark as noise if **any** of these are present:
  - `List-Unsubscribe` header exists (non-empty)
  - `List-Id` header exists (non-empty)
  - `Precedence` header value is `bulk`, `list`, `junk`, or `auto` (case-insensitive)
  - `X-Auto-Response-Suppress` header exists (non-empty)

### Step 3 — Detection at persist time

In `src/db/message-persistence.ts`:
- Check labels for Gmail noise categories. If labels JSON contains any of `Promotions`, `\\Promotions`, `Social`, `\\Social`, `Forums`, `\\Forums`, `Spam`, `\\Spam`, `Junk`, `\\Junk`, `Bulk` (case-insensitive) → mark noise. Note: We exclude "Updates" category as it contains important transactional emails (bills, receipts, confirmations).
- Final `is_noise` = `parsed.isNoise || labelIsNoise ? 1 : 0`.
- Include `is_noise` in the `INSERT INTO messages` statement.

### Step 4 — Search integration

In `src/search/index.ts` (`SearchOptions`):
- Add `includeNoise?: boolean` (default `false` — noise excluded unless opted in).

In `src/search/filter-compiler.ts` (`buildFilterClause`):
- When `includeNoise` is falsy (the default), append `m.is_noise = 0` as an AND condition (independent of `filterOr` — always AND, since it's a global constraint, not a per-field filter).

### Step 5 — Ask integration

In `src/ask/tools.ts` (`executeSearchTool`):
- Do not pass `includeNoise` — let it default to `false`. Ask always operates over personal/transactional mail, same as search.
- Update the `search` tool description to mention: "Noise messages (promotional, social, forums, bulk, spam) are excluded by default."

### Step 6 — CLI and MCP exposure

CLI `search` command (`src/cli/index.ts`):
- Add `--include-noise` boolean flag (default: `false`). When passed, sets `includeNoise: true` in the search call.

MCP search tool (`src/mcp/`):
- Add `includeNoise` boolean parameter to the search tool schema. Document: "When true, includes noise messages (promotional, social, forums, bulk, spam) in results. Defaults to false."

---

## References

- Schema: `src/db/schema.ts` (`messages.labels`)
- Ask pipeline: `src/ask/agent.ts`, `src/ask/tools.ts`
- Search: `src/search/index.ts`
- OPP-018 (newsletter detection) mentions `List-Unsubscribe` for newsletter detection — can reuse or align signal definitions
