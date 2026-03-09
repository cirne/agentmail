# BUG-020: Apple / Vendor Spending Query — Domain Not Routed to fromAddress

**Status:** Open (accepted for ship). **Created:** 2026-03-10. **Tags:** ask, eval, search

**Design lens:** [Agent-first](../VISION.md) — For "summarize my spending on apple.com" (and similar vendor/domain spending queries), the system should return all transactional emails from that sender. Today the agent or the backend often treats the domain as a keyword, so we get incomplete or irrelevant results.

**Supersedes:** The remaining open item from [BUG-016](archive/BUG-016-bakeoff-incomplete-coverage-critical.md) (archived), which covered multiple issues; those others have been addressed (instructions, tool docs, noise-excluded-by-default, eval known-issue). This bug scopes only to **domain→from routing** and the **eval gap** for the apple spending case.

---

## Summary

For questions like "summarize my spending on apple.com in the last 30 days":

- **Intended behavior:** Treat "apple.com" as a sender/domain filter and return all non-noise messages from that domain (exhaustive list). With noise excluded by default, that set is mostly receipts/transactional and fits a reasonable limit.
- **Current behavior:** The nano agent often sends the domain in the **query** parameter (e.g. `query: "apple.com"`) instead of the **fromAddress** parameter. The search layer then runs FTS with a phrase like `"apple.com"`, which can match the wrong set or truncate. The eval case scores ~0.4–0.6 and we accept it via `minScore: 0.4` and `knownIssue` (see [ask.eval.test.ts](../../src/ask/ask.eval.test.ts)).

We are **OK shipping** with this gap: the eval is explicitly marked as a known issue, and instructions/tools were updated to tell the agent to use the fromAddress parameter. Backend domain→from routing (see below) would make the behavior robust even when the agent puts the domain in the query.

---

## Root cause

1. **Agent uses query instead of fromAddress:** Nano sometimes puts `"apple.com"` or even `"fromAddress:apple.com"` in the search **query** string instead of setting the **fromAddress** parameter. So we never take the filter-only (exhaustive) path.
2. **No backend fallback:** Search does not detect domain-like tokens in the query and rewrite them to a from: filter. So when the agent sends `query: "apple.com"`, we run FTS (phrase or OR) instead of `from_address LIKE '%apple.com%'`.

---

## Fix options

1. **Backend domain→from routing (recommended):** In `searchWithMeta` (or query parsing), detect a domain pattern in the query (e.g. `word.tld` like `apple.com`, `amazon.com`). If present and no explicit fromAddress is set, set `fromAddress` to that domain and remove the token from the text query. Then "apple.com spending" → from: apple.com + query "spending", and we get exhaustive sender results.
2. **Stronger agent/tool wording:** Already updated (two-pattern instructions, "Do NOT put fromAddress or the domain in the query string"); further tightening possible if nano keeps misusing the parameter.
3. **Eval:** The case remains in the suite with `minScore: 0.4` and `knownIssue: "BUG-020: ..."` so we don't regress and can remove the known-issue once the fix is in.

---

## References

- Eval case: [ask.eval.test.ts](../../src/ask/ask.eval.test.ts) — "summarize my spending on apple.com in the last 30 days", `knownIssue` points here.
- Search: `src/search/index.ts` — `searchWithMeta`, `parseSearchQuery`; filter-only path in `filter-compiler.ts`.
- Original broad bug (archived): [BUG-016](archive/BUG-016-bakeoff-incomplete-coverage-critical.md).
