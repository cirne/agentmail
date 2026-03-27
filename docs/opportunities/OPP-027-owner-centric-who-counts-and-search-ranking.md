# OPP-027: Owner-Centric `who` Counts + Contact-Aware Search Ranking

**Status:** Proposed — **user value not yet validated.**

**Problem:** `zmail who` and the `people` table expose **address-centric** counts (`sentCount` = messages *from* that address, `receivedCount` = messages where that address appears in To/Cc). That matches database columns but misleads users and agents who read “sent” as “I emailed them.” Separately, **`zmail search`** historically used **FTS5 BM25 + date recency** only; it had no **owner-centric interaction rank** for ordering.

**Hypothesis:** Precomputing **owner-centric** interaction counts (and a compact **`contactRank`** scalar derived from those fields) could improve product behavior. **Where that helps most is unclear** — search ranking alone may be a weak win (see **User value** below). A **stronger** story may be **`refresh`** / **`inbox`** signal-to-noise: surface or protect mail from people you **regularly** correspond with so it is not buried under bulk, newsletters, or low-salience churn. **Naming:** `contactRank` is an indexed-mail ordering signal, not a judgment of personal worth.

**`zmail who` requirement:** Result ordering **must** use this same signal: **`people` sorted by `contactRank` descending** — the more the owner is in contact with someone (per the documented fields and rank formula), the **higher** they appear in the list. Fuzzy name/query match quality may act as a **filter** (“who matches this string?”) or **secondary tie-breaker**, but **primary sort** is **not** “best string match first”; it is **“most contacted / strongest mailbox interaction signal first”** among matches. The MCP **`who`** tool should match CLI behavior. Expose **`contactRank`** in JSON for debugging and agent reasoning.

---

## Semantics: proposed JSON fields (per merged person)

All counts are over messages in the indexed corpus. The owner address comes from config (`ZMAIL_EMAIL` / `config.json`).

| Field | Meaning |
|-------|---------|
| **`sentCount`** | Messages **you** sent **to** this person that **start a thread** — your first outbound message in that `thread_id` where they are a recipient (new compose to them counts here). |
| **`repliedCount`** | Messages **you** sent **to** this person that are **replies** in an existing thread (not that first outbound). |
| **`receivedCount`** | Messages **from** this person **to** you (`from_address` matches their identity). |
| **`mentionedCount`** | Messages where this address appears in **`cc_addresses`** (e.g. A emails you and copies B → B’s `mentionedCount` increments). Optionally include CC when **you** copy someone; document the rule explicitly. |
| **`lastContact`** | Latest `date` among messages involving this person (any direction), for recency. |
| **`contactRank`** | Log-scaled ordering score from the counts above (shared with search / refresh / inbox). Not “personal importance.” |

**Invariants (when classifying owner → them):** each outbound message to a given person should count exactly once as either **`sentCount`** or **`repliedCount`**, so **`sentCount + repliedCount`** = total mail from you to them.

**Relationship to today:** Current `who` SQL treats “sent” as from-address and “received” as To/Cc presence — the opposite of the intuitive owner-centric reading. This opportunity is a **breaking semantic change** for those fields; migrate docs, MCP tool descriptions, and tests accordingly. Drop duplicate use of `mentionedCount` as identical to “received” in the old sense; **`mentionedCount`** becomes **CC-only exposure** as above.

**Filtering:** Reuse noreply/bot heuristics ([OPP-012](OPP-012-who-smart-address-book.md), `is_noreply`) so automated addresses do not dominate **`sentCount`** / ranking.

**Non-goals (for this opp):** Named groups (“family”, “team”), LLM clustering, and explicit “people map” UI — only **per-contact numeric signals** and downstream ranking / filtering.

---

## Integration with `zmail who`

**Contract:** After owner-centric counts and **`contactRank`** exist, **`zmail who`** (and MCP **`who`**) must sort the **`people`** array by **descending `contactRank`** — more indexed interaction → higher in output.

- **`contactRank`** is computed from the same weighted / log-scaled combination of **`sentCount`**, **`repliedCount`**, **`receivedCount`**, **`mentionedCount`** (and optionally **`lastContact`**) documented above; exact weights TBD but must be **shared** with search / refresh / inbox so the signal means one thing everywhere.
- **Query behavior:** Results are still **restricted** to identities matching the user’s query (name/address fuzzy match). Within that set, **do not** sort primarily by fuzzy match score; sort by **`contactRank`**. If no query is used (if the CLI ever supports “list top contacts”), order is pure **`contactRank`**.
- **Rationale:** Agents and users use `who` to find **people they actually correspond with**, not only the best lexical match to a string — “Sterling” should list a high-volume coworker above a one-off `sterling@…` match when both hit.

### Test case — `who` sort

**Setup:** Two addresses both match `zmail who "sterling"` — one is a **frequent** correspondent (high `contactRank`), one is a **rare** or automated hit (low `contactRank`).

**Expected:** The **frequent** correspondent appears **first** in `people`, even if the rare row is a slightly better fuzzy string match.

---

## User value (uncertain)

**Search / ask:** Contact-rank boosting is easy to **over-sell**. Keyword relevance still dominates: e.g. a query like `travel` can rank **shared Apple News / “TRAVEL + LEISURE”** articles from a close contact above rarer but salient mail from others because the indexed text matches strongly — **not** because `contactRank` ranked them first. A participant boost only helps when FTS scores are **similar**; it does not fix **noisy literal matches** from high-volume senders. **Validate with real queries** before investing; measure whether users perceive better answers or just different ordering.

**Possibly higher value — `refresh` / `inbox`:** The same **`contactRank`** signal may matter more for **“what’s new that I care about?”** than for keyword search. Examples:

- When classifying or ordering **recent mail**, **never drop** (or always include in a “people” band) messages from addresses above an interaction threshold — even when heuristics label mail as noise, promotional, or low priority.
- **Pin or boost** threads from **regular correspondents** in `inbox` / refresh output relative to one-off marketing or automated mail.
- Reduces **false negatives** (“I missed something from X”) more than it changes **FTS tie-breaks**.

Treat **refresh + inbox** as a **primary candidate** for validating user value; treat **search ranking** as **secondary** unless evals show clear wins.

---

## Integration with search results

Search computes **`combined_rank = fts_rank - dateBoost`** and orders by that (`ftsSearch` in `src/search/index.ts`); filter-only search uses a JS mirror of the date term plus the same rerank. **`contactRank`** should **not** replace FTS; it **adjusts ranking after** keyword relevance (or date ordering for filter-only).

**Recommended approach:**

1. **Precompute or cache** per **normalized address** (and/or merged person id): a compact **`contactRank`** derived from owner-centric fields, e.g. weighted sum favoring **`sentCount`** (thread starts) over **`repliedCount`**, plus **`receivedCount`** so people who write you often are not invisible, plus a smaller weight on **`mentionedCount`**. Use **log scaling** or caps so one noisy list does not dominate.

2. **At search time**, for each candidate message row, compute a **participant boost** from addresses on the message: `from_address`, plus parsed **`to_addresses`** / **`cc_addresses`**. Take the **max** (or sum with diminishing returns) of **`contactRank`** scores among participants **excluding the owner**.

3. **Blend into ranking:** e.g. `final_rank = combined_rank - participantBoost` (same sign convention as date: lower is better), or a two-stage sort: order by `combined_rank`, then apply a stable rerank by boost within a small FTS band. Start with a **small** boost so keyword relevance remains primary.

4. **Observability:** Optional debug field on JSON search results (`contactRankBoost` when `DEBUG_SEARCH=1`) for tuning.

5. **Performance:** Avoid N+1 queries per row; prefer a single lookup table keyed by address (or batch join) populated during a **`rebuild-people`** / sync hook, similar in spirit to `rebuild-people` / dynamic `who` aggregation.

**Downstream:** `zmail ask` benefits without bespoke prompt changes if retrieval already uses `search()`. MCP `search_mail` inherits the same ordering.

### Test case — search (conditional)

**Setup:** Two senders with **similar FTS strength** for the same query (not one sender with much stronger keyword matches). Owner-centric scores differ (e.g. high bilateral volume vs occasional contact).

**Query:** e.g. `zmail search "<phrase>" --limit 15`.

**Expected if search integration ships:** The **closer** the BM25 scores, the more **contact-rank boost** should matter; dominant keyword matches should still win.

**Reality check (dogfood):** A query like `travel` may return **many** hits from a spouse who forwards **Travel + Leisure** / Apple News — **strong literal matches**, not proof of relationship ranking. Use this scenario to test **tie-breaking**, not “my partner always wins travel.”

### Test case — refresh / inbox (possibly higher bar for value)

**Setup:** Recent sync includes a mix of **newsletters, notifications**, and **mail from regular correspondents** (high owner-centric score).

**Expected:** **`refresh`** / **`inbox`** output **includes or elevates** threads from regular correspondents relative to bulk; **does not** silently omit important human mail because a generic noise classifier fired. Exact UX (separate section vs boost vs filter) TBD.

---

## Open questions

- **Who sort vs fuzzy match:** Confirm tie-breaking when two matches have near-equal `contactRank` (e.g. `lastContact` DESC, then primary address).
- **Which surface proves value first?** `refresh` / `inbox` vs `search` / `ask` — need success metrics (e.g. missed-salient-mail rate, subjective “useful ordering” in evals). **`who` sort** is a **concrete deliverable** that validates **`contactRank`** in isolation.
- Exact **weights** and **caps** for **`contactRank`**; validate on real mailboxes.
- **CC-only** vs **Cc + Bcc** (if Bcc is ever stored) for `mentionedCount`.
- Whether **multi-recipient To** should contribute to `mentionedCount` or only **Cc** (current story is CC-focused).
- **Incremental updates:** recompute counts on each sync vs periodic batch job (user envisioned a rare batch after first large sync; incremental keeps search and refresh fresh).

---

## Related

- [OPP-012](OPP-012-who-smart-address-book.md) — smart address book; proposed `relationship` score partially overlaps (implement owner-centric counts first, then relationship score can wrap them).
- [OPP-001](OPP-001-personalization.md) — user context for search; contact boosts are complementary (structural vs lexical personalization).
- [OPP-019](OPP-019-fts-first-retire-semantic-default.md) — FTS-first retrieval; this opp strengthens FTS ranking without adding embeddings.
- [OPP-021](OPP-021-ask-spam-promo-awareness.md) — spam/promotional awareness for ask/search; **refresh/inbox** work here may combine **noise filters** with **regular-correspondent protection** so human mail is not dropped with bulk.
