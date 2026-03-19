# Critical Analysis: Plan → Scatter → Assemble → Synthesize Merge

**Branch:** `feature/plan-scatter-search`  
**Purpose:** Decide whether this refactor is a step forward or backward, and what to validate before merging to main.

---

## 1. Refactor Summary

- **Before (v1 on main):** Nano agentic loop (up to 5 rounds) with tools → context assembly → Mini synthesis. Heavy retry/recovery (filtered-failure counter, includeNoise retry, “try broader searches” prompts). BUG-020: Nano often put domains in `query` instead of `fromAddress`.
- **After (v2):** Single Nano planner (JSON) → scatter (parallel FTS) → assemble (tiered context) → Nano synthesis. No retrieval loop, no recovery from a bad plan. Schema: FTS5 now indexes `from_address`, `from_name`, `attachment_text` (schema v12).

---

## 2. When This Refactor Could Be a Step Backward

### 2.1 One-shot planner has no recovery

**Risk:** If the planner misinterprets the question, the whole answer is wrong. There is no “see results → adjust search” step.

**Concrete regressions:**

- **Unseen query shapes:** Eval covers person lookup, “today”, apple spending, “5 most recent”, invoices. Queries like “what was the issue with my subscription?”, “emails from the guy I met at the conference”, “everything from Stripe except receipts” have no prompt examples. The planner may emit wrong `patterns`/`fromAddress`/dates or omit `includeNoise` when needed.
- **Ambiguous intent:** “Show me emails about the project” — project could be a keyword, a sender, or a thread. One plan commits to one interpretation; if wrong, we don’t retry.
- **Vendor/domain not in prompt:** Planner prompt lists Apple, Amazon, Google, Stripe, GitHub, Netflix, Spotify. Any other vendor (e.g. “Adobe”, “Microsoft”) may end up as a pattern instead of `fromAddress`, reproducing BUG-020-style misses for that domain.

**V1 had:** Multiple tool rounds, “try broader searches” and “retry with includeNoise” when candidates were empty. So v1 could sometimes recover from a bad first move; v2 cannot.

### 2.2 “Today” and “0d” in scatter (fixed)

**Previously:** `parseSinceToDate("0d")` threw, so `resolveDate()` dropped `afterDate` for “today”.

**Now:** `scatter.ts` treats `"0d"` / `"0"` as start of today (`YYYY-MM-DD`) before SQL. Covered by `src/ask/scatter.test.ts`.

### 2.3 Too many hits and silent truncation

**Risk:** With no date bug, “list all apple purchases since 1/1/26” can still return hundreds of hits. Assemble fills tiered context up to 80k chars then stops. Messages beyond that are never seen by the model; the user gets an answer that may look complete but is missing most of the data.

**V1:** Same 80k cap, but the agent could do multiple searches and prioritize (e.g. by thread or by reading a few messages). So v1 could sometimes “see” that there were too many and adjust. V2 does not observe hit count or distribution; it just truncates.

**Worse when:** Broad patterns (“receipt”, “order”) + large mailbox. Planner correctness (e.g. strong `fromAddress` use) is the main mitigation; if the planner is wrong, this gets worse.

### 2.4 Newsletter / noise-dependent queries

**Risk:** If the user asks something that requires promotional/newsletter mail (e.g. “what newsletters did I get this week?”), the planner must set `includeNoise: true`. There’s no second chance if it sets `false`.

**V1:** Had an explicit retry: if Phase 1 found zero candidates, it re-ran the same searches with `includeNoise: true`. V2 has no such fallback.

### 2.5 Schema and migration burden

**Risk:** Schema goes from 9 → 12. `from_address` and `from_name` enter FTS5; `attachment_text` is added with triggers. Existing DBs need to be upgraded (or recreated). Docs say “no migrations” and suggest manual ALTER or full reset. So merge implies either documenting an upgrade path or accepting “reset data dir” for existing users.

**Verdict:** Mostly operational/deployment; not a functional regression of “ask” itself, but a real cost for anyone with an existing index.

### 2.6 Synthesis model: Mini → Nano

**Risk:** V1 used Mini for synthesis; v2 uses Nano. The experiment doc says quality held on the Marcio Nunes case (0.80–0.90). That’s one qualitative test. For complex, multi-document synthesis (long threads, compare-and-contrast, subtle distinctions), Nano might underperform Mini. We have not systematically tested that boundary.

---

## 3. When This Refactor Is a Step Forward

- **BUG-020:** Planner prompt explicitly routes domains to `fromAddress` with examples; scatter uses that in SQL. So domain-filtered spending/receipt queries are more reliable than v1’s tool-call behavior.
- **Date bug (relative in SQL):** Fixed by `resolveDate()` so `"30d"` etc. become ISO before SQL. V1 had no such bug (tools received params and search layer may have handled them), but v2’s scatter was broken without this fix.
- **Latency and cost:** Fewer LLM rounds (2 vs 2–7), cheaper model for synthesis (Nano). Target 1.5–3s vs 4–12s is a real improvement if we’re confident in plan quality.
- **Code health:** No 350+ lines of retry/scaffolding; pipeline is testable (planner, scatter, assemble each unit-tested). v1’s “consecutiveFilteredFailures” and injected user messages were hard to reason about.
- **Schema:** FTS5 over `from_address`, `from_name`, `attachment_text` is a clear win for both v1 and v2; merging schema changes is recommended regardless of pipeline choice.

---

## 4. Queries and Use Cases to Validate Before Merge

Below are concrete query types and scenarios that would either expose regressions or build confidence. Recommended: add a subset as eval cases or manual test scripts, and run on both v1 (agent-v1) and v2.

### 4.1 Planner robustness (one-shot)

- **“Summarize my spending on Adobe in the last 30 days”** — Vendor not in planner examples; confirm `fromAddress` is set (e.g. `adobe.com`) and not only patterns.
- **“What was the issue with my subscription?”** — No explicit vendor/date; confirm planner chooses reasonable patterns and optional date range.
- **“Emails from the person I met at the conference”** — Ambiguous; no proper “from”; confirm we don’t get a nonsensical plan (e.g. domain in patterns).
- **“What newsletters did I get this week?”** — Must set `includeNoise: true`; confirm we get newsletter results.

### 4.2 Date handling

- **“What emails did I get today?”** — Fix or special-case “0d” so that “today” gets an `afterDate` = start of today; then validate that only today’s messages are in context (or at least that the answer is about today).
- **“Emails from last month”** — Planner gets “last month” in prompt; confirm `afterDate`/`beforeDate` are correct and scatter resolves them (no raw relative strings in SQL).
- **“Everything from Stripe since 1/15/26”** — US date format; confirm planner outputs ISO and scatter applies the filter.

### 4.3 High-hit and truncation behavior

- **“List all apple purchases since 1/1/26”** (with many such messages) — Confirm either: (a) answer explicitly says “showing first N of M” or similar, or (b) we have a product decision to add such a signal. At least validate we don’t silently imply completeness when we truncated.
- **“What are my 5 most recent emails?”** — Should have few patterns and no heavy truncation; confirm answer lists 5 and ordering is correct.

### 4.4 Person and relationship

- **“Who is Marcio Nunes and how do I know him?”** — Already in evals; keep as regression test. Validates patterns + optional from + synthesis quality.
- **“Find emails where Dan suggested something about the Cabo trip”** — Multi-term (person + topic); confirm planner uses patterns like “dan”/“cabo” and doesn’t over-filter by fromAddress unless appropriate.

### 4.5 Edge cases and errors

- **Malformed or adversarial prompt** — e.g. “search for )))” or very long question. Confirm planner fallback (keyword-split) is used and scatter doesn’t crash (FTS5 syntax errors are already caught per scatter tests).
- **Empty mailbox / no matches** — Confirm we get a clear “no emails found” style answer, not a generic or hallucinated summary.

### 4.6 Synthesis quality (Nano vs Mini)

- **Long thread with multiple decisions** — One thread, many messages, question like “what did we decide about the timeline?”. Compare v1 (Mini) vs v2 (Nano) for completeness and accuracy.
- **Compare-and-contrast** — “What’s the difference between the two proposals?”. Again compare v1 vs v2.

---

## 5. Recommended Validation Plan

1. **Fix “0d” / “today”** in scatter (or planner) so “today” queries are date-bounded. Re-run “what emails did I get today?” eval.
2. **Validate on real variety, not eval-shaped prompts.** Avoid tuning the planner prompt or adding post-processing so a fixed eval suite turns green — that overfits. Prefer manual or scripted checks on a real inbox and diverse questions; keep evals as smoke tests, not the product spec.
3. **Run a small bakeoff** on a real inbox (or a large fixture): 5–10 queries covering “today”, last month, vendor spending, newsletters, “5 most recent”. Compare v1 vs v2 on correctness and latency; document any regressions.
4. **Document schema upgrade** for v9 → v12 (or state “reset data dir recommended”) so deploy/merge is clear.
5. **Optional:** Add one “too many hits” scenario and define desired product behavior (e.g. “showing first N” in the answer or a future “observe and re-plan” step).

---

## 6. Conclusion

The refactor is a **step forward** on clarity, testability, BUG-020, and latency, but a **step backward** on recovery from bad plans, newsletter fallback, and possibly synthesis quality on complex questions. The “0d”/today bug is a real defect that should be fixed before merge. Before considering it merge-ready:

- Fix and validate “today”/“0d”.
- Exercise the planner on diverse real questions (not only eval fixtures); avoid eval-specific prompt or `normalizePlan`-style hacks.
- Optionally compare v1 vs v2 on a few complex-synthesis and high-hit scenarios.

Merging **schema changes** to main is still recommended; keeping **v2 as the default ask pipeline** is reasonable if the above validation passes and the product accepts “no recovery from a bad plan” in exchange for simplicity and speed.
