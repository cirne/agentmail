# OPP-037: Deterministic Inbox Rules — Clean Slate (No LLM Triage)

**Status:** Open. **Created:** 2026-04-04. **Updated:** 2026-04-04 (scope decision). **Tags:** inbox, rules, triage, heuristics, testing, personalization, deterministic

**Related:** [OPP-032](OPP-032-llm-rules-engine.md) (historical: rules in LLM prompt — **superseded for inbox by this decision**), [OPP-035](OPP-035-inbox-personal-context-layer.md) (facts vs action policy), [OPP-021](OPP-021-ask-spam-promo-awareness.md) (header/category signals), [ADR-027](../ARCHITECTURE.md#adr-027-stateful-inbox--no-daemon-soft-state-on-schema-bump) (stateful inbox)

---

## Decision (2026-04-04)

**We are designing from zero.** Inbox triage **does not use an LLM batch** (`zmail inbox` does not call OpenAI for classification). Policy lives in **`rules.json`** as **typed, deterministic** rules only. A **calling agent or human** edits that file; there is **no `llm` rule kind** and no prose conditions interpreted at triage time.

**Rationale:** Stable `matchedRuleIds`, full unit-testability, zero API cost/latency for inbox, no hallucinated rule ids. Start with a **strong default rule pack** (noreply, unsubscribe/snippet signals, list category, OTP/notify patterns, etc.), measure real-world gaps, then extend matchers or defaults — **simplify first**.

**Out of scope for inbox:** `zmail ask`, setup/wizard LLM checks, `draft edit`, and other features keep using OpenAI where they already do; only **inbox classification** is deterministic.

---

## Problem (historical)

Previously, every entry in `rules.json` was **free text** folded into the inbox classifier **system prompt**; the model decided matches and emitted `matchedRuleIds`. That caused unstable ids, no unit-testable matching, and tension with stripper/archive logic when the model omitted or invented ids.

The codebase already had **deterministic** signals (`evaluate_fallback_heuristic`, category, noreply, unsubscribe word). The clean-slate approach makes **user-visible rules** the same kind of thing: **executable, typed rows** evaluated in Rust.

---

## Proposal

### Rule kinds (inbox only — no LLM interpretation)

| Kind | Role | Example |
|------|------|---------|
| **Predicate** | Match on indexed metadata | `fromDomain`, `category`, normalized `fromAddress` |
| **Regex (bounded)** | Match on subject / full plain body / from | `subjectPattern`, `bodyPattern`, `fromPattern` |
| **Heuristic** | Named internal signal | `noreply`, `excludedCategory`, `listCategory`, `unsubscribeWord`, marketing-style subject/snippet (aligned with today’s fallback helpers) |

Every rule has **`id`**, **`action`** (`notify` \| `inform` \| `ignore`), **`kind`**, and kind-specific fields. Optional **`priority`** (lower = earlier) and **`description`** (for humans/agents; not sent to any inbox model).

### Execution model

1. **Load & compile** `rules.json` — validate kinds, compile regexes, reject duplicates and unsafe patterns.
2. **Per-candidate evaluation** over [`InboxCandidate`](../../src/inbox/scan.rs) (message_id, from, subject, snippet, full `body_text`, category, …): run matchers in documented order; collect **matched rule ids** from the file only.
3. **Resolve action** when one or more rules fire: e.g. **`notify` > `inform` > `ignore`** among matches, or **highest-priority** rule wins — pick one policy, document it, test it.
4. **No rule matched:** apply a **single built-in fallback** (reuse / consolidate [`evaluate_fallback_heuristic`](../../src/inbox/scan.rs) behavior) so behavior stays predictable — e.g. default `inform` with `decision_source: fallback`.
5. **Post-pass (keep):** self-mail heuristic, stripper-style overrule if still desired for `ignore`, [`ignore_should_apply_local_archive`](../../src/inbox/scan.rs) — but base classification inputs come from **rules + fallback**, not from OpenAI.

### `requiresUserAction` / `actionSummary`

Today these are LLM outputs. For v1 deterministic inbox, **default both off** (`false` / empty) unless a later typed rule field adds them. Document in skill that “todo hints” may return in a future iteration.

### `context` in `rules.json`

Optional **narrative blobs for agents** reading the file — **not** consumed by inbox triage logic. Agents use `context` to remember user preferences when **authoring** rules.

### Schema

- **Breaking OK:** no legacy free-text-only rules. Version **`rules.json`** (e.g. `version: 2`).
- **`zmail rules validate`** — load, compile, report errors.

### Default rule pack (new users)

Ship **bundled defaults** (noreply → ignore, list/excluded category → ignore, unsubscribe / marketing-style snippet or subject → ignore, OTP / verification / security-ish patterns → **notify**, etc.). Write **`~/.zmail/rules.json` only when missing**; never clobber user files. Optional `zmail rules reset-to-default --force`.

### Inbox JSON hints (agent nudges)

[`inbox_json_hints`](../../src/refresh.rs) already appends short strings to inbox JSON (large surfaced set, sender skew, scan vs surface gap, ignore-heavy outcomes, `--diagnostics`, archive reminders). **Deterministic inbox must refresh this layer:**

- **Wording:** Drop or rewrite anything that assumes an LLM classifier (e.g. over-emphasizing `requiresUserAction` if v1 is always false); keep nudges toward **`zmail rules`** and typed rule shapes.
- **New signals (optional v1):** e.g. many rows with `decision_source: fallback` and repetitive bulk-like senders → hint to add a **domain** or **regex** ignore rule; many `inform` for similar marketing snippets → suggest snippet/subject pattern. These are **heuristic, non-blocking** — same spirit as today’s “add explicit ignore rules so future runs stay stable.”
- **Tests:** Extend [`inbox_json_hints_tests`](../../src/refresh.rs) when new branches or copy change.

---

## Implementation plan (concise)

1. **Schema + validate + default JSON** — serde-tagged rules, no LLM kind; golden default file; seed from setup/wizard and/or first load.
2. **Matcher engine** — pure `eval_rules(rules, candidate) -> { ids, action, note }` + unit tests per kind.
3. **Replace inbox LLM path** — `run_inbox_scan` uses a **deterministic classifier** (implements `InboxBatchClassifier` or refactor trait usage) — **no API key** required for `zmail inbox`. Remove / stop calling [`OpenAiInboxClassifier`](../../src/inbox/scan.rs) and [`build_inbox_rules_prompt`](../../src/rules.rs) from the inbox command path; delete or repurpose dead prompt code as appropriate.
4. **Fingerprint** — hash compiled rule set for `inbox_decisions` cache; bump when schema or defaults change.
5. **Integration tests** — `tests/inbox_scan.rs`: default pack behavior, priority/severity, fallback when no rule matches, archive hints when rule ids present.
6. **Inbox hints** — audit [`inbox_json_hints`](../../src/refresh.rs) for deterministic semantics; add/adjust hints that steer agents to **author rules** (spam-like clusters, fallback-heavy windows); update unit tests in `refresh.rs`.
7. **Docs** — [INBOX-CUSTOMIZATION.md](../../skills/zmail/references/INBOX-CUSTOMIZATION.md), [ARCHITECTURE.md](../ARCHITECTURE.md) ADR snippet, skill: inbox is deterministic; agents maintain `rules.json`.

---

## Non-goals (v1)

- LLM batch classification for `zmail inbox`.
- `llm` or free-text **match** rules in `rules.json`.
- Arbitrary code execution in rules.
- Perfect i18n for naive regex (document limitations).

---

## Success criteria

- `zmail inbox` runs **without** `ZMAIL_OPENAI_API_KEY` (for classification).
- Every `matchedRuleId` in output **exists** in `rules.json` (or is empty when only fallback applies).
- Default pack gives reasonable **ignore** for bulk signals and **notify** for auth/code-style mail on synthetic fixtures.
- “Does rule R match candidate C?” is **unit-testable** without network.
- Docs and skill state clearly: **inbox = deterministic rules**; **agents edit rules** to improve behavior over time.
- Inbox JSON **`hints`** stay **actionable** for agents (including nudges to add rules when the scan looks skewed or fallback-heavy).

---

## Open questions

- Exact **action resolution** among multiple firing rules: strict severity vs priority-first.
- Whether to **keep or simplify** stripper overrule when there is no model `ignore` to second-guess.
- Regex **`bodyPattern`** matches full stored plain-text body (`messages.body_text`).
- Reintroducing **semantic** triage later (optional LLM tier) if defaults + agent-edited rules prove insufficient — explicitly deferred, not part of this decision.
