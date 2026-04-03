# BUG-024: `zmail check` / inbox scan Over-Filters — Misses Mail the User (or Calling Agent) Would Care About

**Status:** Closed — verified (2026-04-03). **Created:** 2026-03-20. **Tags:** inbox, check, llm, agent-first, recall

**Resolution:** Rewrote `build_inbox_rules_prompt` ([`src/rules.rs`](../../../src/rules.rs)): junk-stripper framing, mandatory `notify|inform|ignore` per message, **prefer `inform` when unsure** (not `ignore`), explicit same-day travel/aviation/ops guidance, forbid bulk-assigning `ignore` to a whole batch. Bumped `INBOX_RULES_PROMPT_VERSION` to **6** so cached inbox decisions recompute. Parser fallback `fallback_action` now defaults ambiguous/non-heuristic mail to **`inform`** instead of **`ignore`** so invalid JSON or omitted rows do not auto-archive everything. `propose_rule_from_feedback` travel keywords now suggest **`inform`** instead of **`ignore`**. **Stripper heuristic:** non-bulk operational mail (e.g. same-day NetJets tail notifications) can **overrule** model `ignore` → **`inform`** (`decisionSource: "stripper"`).

**Verification (2026-04-03):** Live retest with `zmail check --thorough --diagnostics`: same-day NetJets tail notifications (N126QS, N701QS) classified **`inform`**, `decisionSource: "stripper"`, note `"Ignore overruled; not bulk."` — matches expected behavior for time-sensitive aviation ops. Feedback: `ztest/feedback/verified/bug-check-ignores-same-day-flight.md` (attempt 3).

**Design lens:** [Agent-first](../../VISION.md) — **`zmail check`** (Rust CLI; legacy docs may say `inbox`) is a **primitive** for surfacing recent mail to a calling agent. The agent already has user context, goals, and follow-up logic. zmail should **not** second-guess importance aggressively. Prefer **high recall** on the server side: drop only **obvious** junk (newsletters, bulk marketing, noreply noise). **Security notifications, purchases, receipts, shipping updates, calendar invites, and personal/work threads** should generally **pass through** so the agent can rank and explain what matters for *this* user.

---

## Summary

- **Observed:** A 24h window with dozens of messages that look “worth knowing about” in a client (e.g. Important / unread mix) yields a **short** `newMail` list (e.g. 3 items) while `candidatesScanned` is much larger (e.g. 62). Users and agents conclude zmail “missed” important email.
- **Expected:** Inbox scan should behave like a **coarse sieve**: remove clear garbage; **retain** borderline and transactional mail so the **calling agent** can apply judgment. False negatives (dropping something a human would open) are worse than false positives (including something the agent later ignores).
- **Not expected:** Perfect personal ranking inside zmail. The upstream agent is allowed to ignore rows; it cannot recover messages zmail never returns.

---

## Reported example: same-day flight ops classified as `ignore` (2026-04-03)

Agent feedback (`ztest/feedback`): Ran **`zmail check`** with default rules (no `rules.json` customization). A **NetJets** tail-number notification for a **same-day departure** (subject like `N126QS - NetJets Tail Number Notification`, operational details: route, time, crew) was classified **`ignore`** along with the rest of the batch (**`notify: 0, inform: 0, ignore: 30`**). Same-day aviation and logistics mail is time-sensitive; with **zero config** it should not be lumped with ignorable bulk. This matches the bug’s theme: the **LLM triage prompt** defaults toward **`ignore`** for confirmations and “when unsure” cases, which conflicts with **same-day** travel and operations.

---

## Current behavior (implementation)

**Note:** The numbered list below is a **pre-fix** description of how the LLM prompt biased toward `ignore`; resolution and stripper behavior are summarized in **Status / Resolution** above.

**Rust (primary):** [`src/inbox/scan.rs`](../../../src/inbox/scan.rs), [`src/rules.rs`](../../../src/rules.rs) (`build_inbox_rules_prompt`). CLI: **`zmail check`** ([`src/main.rs`](../../../src/main.rs)). **Node reference:** `node/src/inbox/scan.ts` (parity).

1. **Candidates:** Messages with `date >= cutoff`, `is_noise = 0` unless `--include-noise`, ordered by `date DESC`, capped at **80** (`DEFAULT_CANDIDATE_CAP` in `scan.rs`).
2. **No read/unread filter:** Read state is not used in this scan (schema `messages.labels` not wired in).
3. **Not the same as “Gmail Inbox” or “Important”:** Sync is typically All Mail; the scan does not filter by INBOX tabs.
4. **Disposition = LLM:** Batches (default **40**) go to **`gpt-4.1-nano`** with the system prompt from **`build_inbox_rules_prompt`**. Each message gets `notify` | `inform` | `ignore`. Default text explicitly buckets **receipts, confirmations**, and **automated** mail toward **`ignore`**, and says **when unsure between `inform` and `ignore`, prefer `ignore`** — which can suppress **same-day** travel and ops mail unless the model maps it to “same-day deadlines” / `notify` criteria.

**Quality issue:** Wrong `note` text on unrelated threads (e.g. labeling a personal reply as a “security alert”) has been observed — LLM inconsistency on top of recall issues.

**Related:** Rule-feedback helper [`propose_rule_from_feedback`](../../../src/rules.rs) suggests **`ignore`** for “flight / hotel / travel / itinerary” keywords when the user adds rules from free-form feedback — a different code path, but it reflects the same “travel = low surfacing” product bias that fights same-day urgency.

---

## Root cause

1. **Role confusion:** The inbox LLM is acting as a **final curator** (“only what needs human attention”) instead of a **junk stripper** (“remove obvious bulk; keep the rest”).
2. **Prompt skewed toward exclusion:** Explicit exclude list is wide; include list does not strongly bias toward **err on the side of inclusion** for transactional and security-adjacent mail.
3. **Default triage bias:** System prompt tells the model to use **`ignore`** for receipts/confirmations and to **prefer `ignore` when unsure** between `inform` and `ignore`, while **`notify`** is narrow — so same-day **operational** travel (tail numbers, crew, departure in hours) can be misparsed as routine “travel confirmation” noise.
4. **Model capacity:** `gpt-4.1-nano` may under-return on nuanced metadata-only tasks, especially with short snippets.
5. **Hard caps:** `notableCap` (10) and `candidateCap` (80) can truncate recall even when the model is willing to flag more (80 newest-only can miss older-in-window mail).

---

## Expected behavior (product)

| Layer | Responsibility |
|--------|----------------|
| **`zmail check` / scan** | Remove **obvious** junk: newsletters, marketing blasts, social digests, routine noreply churn where clearly safe to drop. **Keep** security/account messages, purchases, receipts, shipping, appointments, **same-day travel/ops and time-critical logistics**, direct person-to-person mail, and anything ambiguous. |
| **Calling agent** | Prioritize, dedupe threads, explain why something matters for this user, omit noise from the *narrative* without hiding raw candidates if needed. |

**Principle:** When in doubt, **include** the message in `newMail` (or a separate “candidates” array — see fix options). Prefer **recall** over **precision** at this layer.

---

## Fix options

1. **Rewrite the system prompt (low cost):** Reframe as “exclude only if clearly bulk/marketing/automated low-value; default **include**; never exclude security, billing, purchases, shipping, **same-day travel/ops**, or personal/work threads on thin evidence.” Add explicit “if unsure, include.” Spell out that **departure/arrival today**, crew/tail/route operational mail is at least **`inform`**, often **`notify`**, not routine “travel confirmation.”
2. **Stronger model for classification (medium cost):** Use a more capable model for the same JSON schema, or a two-step pipeline (nano pre-filter → small model verify).
3. **Raise or split caps:** Increase `DEFAULT_NOTABLE_CAP` and/or `DEFAULT_CANDIDATE_CAP`; or return **`notable`** plus **`lowConfidence`** / full **`candidates`** in JSON for agents that want the full set (documented contract change).
4. **Modes / flags:** e.g. `--inclusive` (bias prompt + higher cap) vs current behavior for backward compatibility; or `--max` to raise notable cap from CLI.
5. **Separate concerns:** Use **`is_noise` + headers/labels** for deterministic junk removal; use LLM only for an optional **ranking** or **notes**, not for hard dropping — hardest to ship but clearest separation.
6. **Tests:** Extend Rust tests in [`src/inbox/scan.rs`](../../../src/inbox/scan.rs) (and Node `scan.test.ts` for parity) with fixture batches that **must** surface security alerts, order confirmations, **same-day travel ops**, and personal threads under default classification.

---

## Acceptance criteria (when closing)

- [x] Documented behavior matches “junk stripper, not final inbox.” (prompt + resolution)
- [x] Representative real-world samples show transactional / time-sensitive mail **included** unless clearly bulk. (2026-04-03: same-day NetJets tail notifications → `inform` via stripper; prior candidate-pool fix with `--thorough`)
- [x] Calling agent can still ignore rows; JSON remains machine-friendly.
- [ ] Regression: obvious newsletter/marketing still tends to be omitted (precision not zero). (manual / future fixture)

---

## References

- Implementation: [`src/inbox/scan.rs`](../../../src/inbox/scan.rs) — `OpenAiInboxClassifier`, `DEFAULT_*_CAP`, batch classify; [`src/rules.rs`](../../../src/rules.rs) — `build_inbox_rules_prompt` (default triage copy).
- Noise pipeline (deterministic): Rust DB/sync paths (`is_noise`, label noise) — see [ARCHITECTURE.md](../../ARCHITECTURE.md).
- CLI: [`src/main.rs`](../../../src/main.rs) — `check`, `review`; [`src/cli/root_help.txt`](../../../src/cli/root_help.txt).
