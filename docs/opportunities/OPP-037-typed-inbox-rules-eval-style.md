# OPP-037: Typed Inbox Rules — Deterministic Checks + LLM Rules (Eval-Style)

**Status:** Open. **Created:** 2026-04-04. **Tags:** inbox, rules, triage, llm, heuristics, testing, personalization

**Related:** [OPP-032](OPP-032-llm-rules-engine.md) (archived foundation: rules/context in prompt, durable decisions), [OPP-035](OPP-035-inbox-personal-context-layer.md) (facts vs action policy — complementary), [OPP-021](OPP-021-ask-spam-promo-awareness.md) (header/category signals), [ADR-027](../ARCHITECTURE.md#adr-027-stateful-inbox--no-daemon-soft-state-on-schema-bump) (stateful inbox)

---

## Problem

Today, every entry in `rules.json` is **free text** folded into the inbox classifier **system prompt**. The model decides whether a rule “matches” and must emit `matchedRuleIds`.

That works for fuzzy intent but produces predictable failure modes:

- **Unstable rule ids** — the model can emit ids that are not in the file, or omit ids when the user would expect a match.
- **No unit-testable matching** — “does this rule apply to this message?” is only observable through LLM calls or brittle prompt snapshots.
- **Heuristic tension** — post-classification steps (e.g. stripper-style overrides) key off signals like “matched user rule” vs “model-only ignore”; when the model does not attach rule ids, behavior diverges from user intent.
- **Redundant context** — users duplicate narrative hints in `context` and long `condition` strings because there is no structured, exact layer.

The product already has **deterministic** signals (sync-time category, noreply/unsubscribe hints, parts of the stripper). User-facing **rules** are not yet first-class citizens in that same **typed** sense.

---

## Proposal (direction)

Introduce **rule kinds** (similar in spirit to mixed eval suites: some checks are LLM-judged, some are exact), for example:

| Kind | Role | Example |
|------|------|---------|
| **Predicate / template** | Match on indexed metadata | `from_domain == "theinformation.com"`, `list_id` matches, header present |
| **Regex (bounded)** | Match on normalized subject / snippet / address | Carefully scoped patterns; clear pre/post conditions |
| **Heuristic** | Reuse or expose existing internal checks as named, user-visible rules | Opt-in wrappers around category + safe predicates |
| **LLM** | Current behavior | Natural-language `condition` + action; best for fuzzy policy |

**Execution model (sketch):**

1. Run **deterministic** rules first in a documented **precedence** order; record real `matchedRuleIds` from the file when a predicate fires (no hallucination).
2. Pass remaining candidates (or all candidates with “already matched” hints) to the **LLM** batch with a shorter or split prompt: LLM rules only for what predicates did not settle.
3. Unify **decision source** / diagnostics so JSON explains: `predicate`, `llm`, `stripper`, and conflicts if a deterministic rule and LLM disagree (policy TBD: deterministic wins, or user-configurable).

**CLI / file shape:** extend `rules.json` with a `kind` (or `type`) field and optional structured fields (`fromDomain`, `subjectRegex`, …) while keeping **backward compatibility** for entries that omit `kind` (treat as `llm`).

**Testing:** predicate and regex matchers get **unit tests** with fixture headers/snippets; LLM rules keep eval-style or snapshot tests at the prompt boundary only.

---

## Non-goals (for v1 of this opp)

- Replacing the entire inbox classifier with a rules engine.
- Arbitrary code execution in rules.
- Perfect internationalization for naive regex on raw headers (document tradeoffs; start with documented limitations).

---

## Success criteria

- User can define at least one **deterministic** ignore/notify/inform rule that **always** sets the correct stable `matchedRuleIds` when headers/metadata match.
- Stripper and archive eligibility can **trust** “user rule matched” when ids are predicate-backed.
- Docs and skill describe when to use **typed** vs **LLM** rules.

---

## Open questions

- Should predicates be **limited to sync-time fields** only, or allow optional body/snippet regex (cost + privacy)?
- Single global ordering vs **priority** integer per rule?
- Interaction with [OPP-035](OPP-035-inbox-personal-context-layer.md): keep narrative facts in a separate layer; typed rules stay mechanical.
