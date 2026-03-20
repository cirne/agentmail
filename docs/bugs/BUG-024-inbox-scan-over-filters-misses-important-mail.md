# BUG-024: `zmail inbox` Over-Filters — Misses Mail the User (or Calling Agent) Would Care About

**Status:** Open. **Created:** 2026-03-20. **Tags:** inbox, llm, agent-first, recall

**Design lens:** [Agent-first](../VISION.md) — `zmail inbox` is a **primitive** for surfacing recent mail to a calling agent. The agent already has user context, goals, and follow-up logic. zmail should **not** second-guess importance aggressively. Prefer **high recall** on the server side: drop only **obvious** junk (newsletters, bulk marketing, noreply noise). **Security notifications, purchases, receipts, shipping updates, calendar invites, and personal/work threads** should generally **pass through** so the agent can rank and explain what matters for *this* user.

---

## Summary

- **Observed:** A 24h window with dozens of messages that look “worth knowing about” in a client (e.g. Important / unread mix) yields a **short** `newMail` list (e.g. 3 items) while `candidatesScanned` is much larger (e.g. 62). Users and agents conclude zmail “missed” important email.
- **Expected:** Inbox scan should behave like a **coarse sieve**: remove clear garbage; **retain** borderline and transactional mail so the **calling agent** can apply judgment. False negatives (dropping something a human would open) are worse than false positives (including something the agent later ignores).
- **Not expected:** Perfect personal ranking inside zmail. The upstream agent is allowed to ignore rows; it cannot recover messages zmail never returns.

---

## Current behavior (implementation)

Relevant code: [`src/inbox/scan.ts`](../../src/inbox/scan.ts).

1. **Candidates:** Messages with `date >= cutoff`, `is_noise = 0` unless `--include-noise`, ordered by `date DESC`, capped at **80** (`DEFAULT_CANDIDATE_CAP`).
2. **No read/unread filter:** Read state is not used in the inbox query (see schema `messages.labels` — not wired into this scan).
3. **Not the same as “Gmail Inbox” or “Important”:** Sync is All Mail for Gmail; the scan does not filter by INBOX or user tabs.
4. **“Interesting” = LLM inclusion:** Batches (default **40**) go to **`gpt-4.1-nano`** with a system prompt that **includes** and **excludes** categories. The model returns only `notable` IDs; results merge up to **10** (`DEFAULT_NOTABLE_CAP`). Snippets are truncated (**400** chars).

The prompt currently tells the model to **exclude** e.g. “generic your order shipped unless time-sensitive” and broad classes of automated mail — which overlaps with what many users still want **surfaced** (purchases, logistics, account alerts) so an agent can summarize or act.

**Quality issue:** Wrong `note` text on unrelated threads (e.g. labeling a personal reply as a “security alert”) has been observed — that’s LLM inconsistency on top of recall issues.

---

## Root cause

1. **Role confusion:** The inbox LLM is acting as a **final curator** (“only what needs human attention”) instead of a **junk stripper** (“remove obvious bulk; keep the rest”).
2. **Prompt skewed toward exclusion:** Explicit exclude list is wide; include list does not strongly bias toward **err on the side of inclusion** for transactional and security-adjacent mail.
3. **Model capacity:** `gpt-4.1-nano` may under-return on nuanced metadata-only tasks, especially with short snippets.
4. **Hard caps:** `notableCap` (10) and `candidateCap` (80) can truncate recall even when the model is willing to flag more (80 newest-only can miss older-in-window mail).

---

## Expected behavior (product)

| Layer | Responsibility |
|--------|----------------|
| **zmail inbox** | Remove **obvious** junk: newsletters, marketing blasts, social digests, routine noreply churn where clearly safe to drop. **Keep** security/account messages, purchases, receipts, shipping, appointments, direct person-to-person mail, and anything ambiguous. |
| **Calling agent** | Prioritize, dedupe threads, explain why something matters for this user, omit noise from the *narrative* without hiding raw candidates if needed. |

**Principle:** When in doubt, **include** the message in `newMail` (or a separate “candidates” array — see fix options). Prefer **recall** over **precision** at this layer.

---

## Fix options

1. **Rewrite the system prompt (low cost):** Reframe as “exclude only if clearly bulk/marketing/automated low-value; default **include**; never exclude security, billing, purchases, shipping, or personal/work threads on thin evidence.” Add explicit “if unsure, include.”
2. **Stronger model for classification (medium cost):** Use a more capable model for the same JSON schema, or a two-step pipeline (nano pre-filter → small model verify).
3. **Raise or split caps:** Increase `DEFAULT_NOTABLE_CAP` and/or `DEFAULT_CANDIDATE_CAP`; or return **`notable`** plus **`lowConfidence`** / full **`candidates`** in JSON for agents that want the full set (documented contract change).
4. **Modes / flags:** e.g. `--inclusive` (bias prompt + higher cap) vs current behavior for backward compatibility; or `--max` to raise notable cap from CLI.
5. **Separate concerns:** Use **`is_noise` + headers/labels** for deterministic junk removal; use LLM only for an optional **ranking** or **notes**, not for hard dropping — hardest to ship but clearest separation.
6. **Tests:** Extend [`src/inbox/scan.test.ts`](../../src/inbox/scan.test.ts) with fixture batches that **must** include security alerts, order confirmations, and personal threads; assert they are not dropped by default classification.

---

## Acceptance criteria (when closing)

- [ ] Documented behavior matches “junk stripper, not final inbox.”
- [ ] Representative real-world samples (or fixtures) show security + transactional + personal mail **included** unless clearly bulk.
- [ ] Calling agent can still ignore rows; JSON remains machine-friendly.
- [ ] Regression: obvious newsletter/marketing still tends to be omitted (precision not zero).

---

## References

- Implementation: [`src/inbox/scan.ts`](../../src/inbox/scan.ts) — `SYSTEM_PROMPT`, `DEFAULT_*_CAP`, `defaultClassifyBatch`.
- Noise pipeline: [`src/db/message-persistence.ts`](../../src/db/message-persistence.ts) (`is_noise` + label-derived noise), [`src/sync/parse-message.ts`](../../src/sync/parse-message.ts).
- CLI: [`src/cli/index.ts`](../../src/cli/index.ts) — `case "inbox"`.
