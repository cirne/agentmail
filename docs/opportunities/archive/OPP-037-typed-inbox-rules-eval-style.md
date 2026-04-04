# OPP-037: Deterministic Inbox Rules — Clean Slate (No LLM Triage)

**Status:** Archived — **implemented** (2026-04-04). **Created:** 2026-04-04. **Updated:** 2026-04-04. **Tags:** inbox, rules, triage, heuristics, testing, personalization, deterministic

**Supersedes:** Inbox **batch LLM** classification and free-text rule “conditions” folded into a model prompt. Inbox policy is now **deterministic Rust** over **`rules.json` version 2** (`kind: "regex"` rules with subject/body/from/category/domain pattern fields — see [`src/rules.rs`](../../../src/rules.rs) and bundled defaults). There is **no** `snippetPattern` in rules; body text uses **`bodyPattern`**. **`zmail ask`** / **draft LLM** paths are unchanged.

**Related:** [OPP-032](../OPP-032-llm-rules-engine.md) (stateful inbox substrate; archived), [OPP-035](../OPP-035-inbox-personal-context-layer.md) (facts vs action policy), [OPP-021](../OPP-021-ask-spam-promo-awareness.md), [ADR-027](../ARCHITECTURE.md#adr-027-stateful-inbox--no-daemon-soft-state-on-schema-bump), [ADR-028](../ARCHITECTURE.md#adr-028-deterministic-inbox--typed-rules-no-llm-triage)

---

## Decision (2026-04-04)

**We are designing from zero.** Inbox triage **does not use an LLM batch** (`zmail inbox` does not call OpenAI for classification). Policy lives in **`rules.json`** as **typed, deterministic** rules only. A **calling agent or human** edits that file; there is **no `llm` rule kind** and no prose conditions interpreted at triage time.

**Rationale:** Stable `matchedRuleIds`, full unit-testability, zero API cost/latency for inbox, no hallucinated rule ids. Start with a **strong default rule pack** (noreply, unsubscribe/body patterns, list category, OTP/notify patterns, etc.), measure real-world gaps, then extend matchers or defaults — **simplify first**.

**Out of scope for inbox:** `zmail ask`, setup/wizard LLM checks, `draft edit`, and other features keep using OpenAI where they already do; only **inbox classification** is deterministic.

---

## Implementation (shipped 2026-04-04)

Delivered in-tree: **`DeterministicInboxClassifier`** ([`src/inbox/rule_match.rs`](../../../src/inbox/rule_match.rs)), **`zmail rules`** CLI, bundled **[`default_rules.v2.json`](../../../src/rules/default_rules.v2.json)**, **`rules_fingerprint`** for `inbox_decisions` cache invalidation, removal of **`OpenAiInboxClassifier`** from the inbox command path, **`inbox_json_hints`** aligned with deterministic copy, integration tests (**`tests/inbox_scan.rs`**, **`tests/rules_cli.rs`**), **[`skills/zmail/references/INBOX-CUSTOMIZATION.md`](../../../skills/zmail/references/INBOX-CUSTOMIZATION.md)**, and **ADR-028** in [ARCHITECTURE.md](../ARCHITECTURE.md).

---

## Problem (historical)

Previously, every entry in `rules.json` was **free text** folded into the inbox classifier **system prompt**; the model decided matches and emitted `matchedRuleIds`. That caused unstable ids, no unit-testable matching, and tension with stripper/archive logic when the model omitted or invented ids.

The codebase already had **deterministic** signals (`evaluate_fallback_heuristic`, category, noreply, unsubscribe word). The clean-slate approach makes **user-visible rules** the same kind of thing: **executable rows** evaluated in Rust.

---

## Proposal (design reference)

The sections below record the **design intent**; behavior is implemented as described in **Implementation (shipped)** and **ADR-028**.

### Rule kinds (inbox only — no LLM interpretation)

v2 **`rules.json`** uses **`"kind": "regex"`** per rule with pattern fields (`subjectPattern`, `bodyPattern`, `fromPattern`, `categoryPattern`, `fromDomainPattern`, etc.) — one serde variant, multiple match surfaces. **`snippetPattern` is not supported** (use **`bodyPattern`** on full stored body). Heuristics and fallbacks live in Rust (`evaluate_fallback_heuristic`, stripper overrule), not as a separate `kind` in the file.

### Execution model

1. **Load & compile** `rules.json` — validate kinds, compile regexes, reject duplicates and unsafe patterns.
2. **Per-candidate evaluation** over [`InboxCandidate`](../../../src/inbox/scan.rs): collect **matched rule ids** from the file only.
3. **Resolve action** when one or more rules fire per implemented policy.
4. **No rule matched:** built-in **fallback** (`decision_source: fallback`).
5. **Post-pass:** self-mail heuristic, stripper-style overrule, local archive hints — inputs from **rules + fallback**, not OpenAI.

### `requiresUserAction` / `actionSummary`

v1 deterministic inbox: **default** `false` / empty unless extended later.

### `context` in `rules.json`

Optional **narrative for agents** authoring rules — **not** consumed by inbox classification logic.

### Schema

- **`rules.json` version 2.** **`zmail rules validate`** — load, compile, report errors.

### Default rule pack

Bundled defaults; **`~/.zmail/rules.json`** only when missing; **`zmail rules reset-defaults --yes`** to replace.

### Inbox JSON hints

[`inbox_json_hints`](../../../src/refresh.rs) — nudges toward **`zmail rules`** and stable rule shapes.

---

## Non-goals (v1)

- LLM batch classification for `zmail inbox`.
- `llm` or free-text **match** rules in `rules.json`.
- Arbitrary code execution in rules.
- Perfect i18n for naive regex (document limitations).

---

## Success criteria (verification)

- `zmail inbox` runs **without** `ZMAIL_OPENAI_API_KEY` (for classification). **Met.**
- Every matched rule id in output **exists** in `rules.json` (or empty when only fallback applies). **Met** (test coverage).
- Default pack gives reasonable **ignore** for bulk signals and **notify** for auth/code-style patterns on fixtures. **Met** (synthetic tests).
- “Does rule R match candidate C?” is **unit-testable** without network. **Met.**

---

## Open questions (post-ship)

Remaining product tuning (not blockers): action resolution among multiple firing rules; stripper heuristics vs new typed rules; optional future semantic tier — explicitly deferred.
