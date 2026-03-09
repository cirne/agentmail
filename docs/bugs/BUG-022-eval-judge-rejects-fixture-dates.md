# BUG-022: Eval Judge Rejects Correct Answers Due to Fixture Dates

**Status:** Open. **Created:** 2026-03-09.

**Problem:** The eval suite's LLM judge (used to score `ask` answers) rejects correct answers when they reference fixture dates in 2026. The judge LLM's training data cutoff is ~2023–2024, so it considers 2026 dates "future" and penalizes the answer for being "inaccurate" — even when the answer correctly lists emails from the test fixture.

**Example:**

Query: `"what emails did I get today?"`

The test fixture sets "today" to 2026-03-10 and inserts emails with that date. The `ask` pipeline correctly identifies and lists those emails. But the eval judge scores it 0.40–0.60 because:

> "The date mentioned (2026-03-10) is in the future relative to the current date (October 2023), making the information inaccurate."

The answer is correct. The judge is wrong.

**Impact:** The "what emails did I get today?" eval case fails intermittently (scores range from 0.40 to 0.60 across runs). This masks real regressions and forces `minScore` workarounds.

**Observed scores across runs:**
- Run 1: 0.60 (fail at threshold 0.70)
- Run 2: 0.40 (fail at threshold 0.70)
- Both answers were factually correct — listed the right emails for the fixture's "today"

---

## Root cause

The eval judge prompt (`src/ask/ask.eval.test.ts`) sends the question + answer to an LLM for scoring but does not include the test context (fixture date, inserted data). The judge LLM evaluates the answer against its own world knowledge, not against the fixture data.

---

## Proposed fix

Add fixture context to the judge prompt so it knows the test's "today" date and expected data:

```
"The test fixture sets today's date to 2026-03-10 and contains specific test emails.
Evaluate the answer based on whether it correctly answers the question given
the fixture context, not based on whether the dates are 'real' or 'current'."
```

Alternatively, switch the judge to a deterministic check for the "today" test case — verify the answer contains the expected message IDs or subjects rather than relying on LLM judgment.

---

## Current workaround

`minScore: 0.3` on the "what emails did I get today?" eval case, with `knownIssue` annotation explaining the judge bug.

---

## References

- Eval suite: `src/ask/ask.eval.test.ts`
- Similar workaround: BUG-020 apple spending test uses `minScore: 0.4`
