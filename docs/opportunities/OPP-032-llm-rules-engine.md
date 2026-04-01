# OPP-032: Stateful Inbox Foundation — Categories, Decisions, and Local Handling State

**Status:** Open. **Created:** 2026-04-01. **Updated:** 2026-04-01. **Tags:** inbox, state, rules, llm, category, archive, diagnostics, dedup

**Related:** [OPP-034](OPP-034-simplified-inbox-cli-check-review.md) (clean-slate user-facing CLI built on top of this foundation), [OPP-001](OPP-001-personalization.md) (user context and personalization), [OPP-021](OPP-021-ask-spam-promo-awareness.md) (promotional/newsletter awareness), [OPP-033](OPP-033-imap-write-operations-and-readonly-mode.md) (provider-side archive/write semantics), [ADR-027](../ARCHITECTURE.md#adr-027-stateful-inbox--no-daemon-soft-state-on-schema-bump) (stateful inbox without daemon)

---

## Problem

Even with a better user-facing CLI, zmail still needs a lower-level inbox foundation:

1. **Messages need durable, queryable inbox decisions.**
   If the system decides something is urgent, summary-worthy, archived-for-later, or suppressible noise, that decision must survive across repeated agent runs.

2. **The product needs stateful alerting and stateful review.**
   "Already alerted the user" and "already included in a review summary" are not the same state, and both differ from "message is archived/handled."

3. **Deterministic inbox metadata is too lossy today.**
   A simple boolean like `is_noise` loses useful distinctions between list mail, promo mail, social mail, bulk mail, spam, and routine automated mail.

4. **User policy and model behavior need an explicit persistence model.**
   Rules, context, decision source, and diagnostics all need a durable home and a crisp contract.

This opportunity is the storage/state/rules foundation that the cleaner `update` / `check` / `review` UX in [OPP-034](OPP-034-simplified-inbox-cli-check-review.md) should sit on top of.

---

## Scope

OPP-032 is intentionally **not** the final user-facing CLI design.

It covers the foundational primitives:

- deterministic message categorization
- durable inbox decision storage
- local handled/archive state
- surfaced-state tracking for alerting and summary workflows
- rules and user context persistence
- diagnostics and decision provenance

It does **not** define the final top-level command names. That is handled in [OPP-034](OPP-034-simplified-inbox-cli-check-review.md).

---

## Core model

### 1. Deterministic message category

Replace the old boolean-noise idea with a richer deterministic `category` field derived at sync time from headers and provider labels.

Example categories:

| Category | Source signals |
|---|---|
| `NULL` | No strong machine-generated/noise signal; likely personal/work mail |
| `promotional` | Gmail Promotions label, marketing-style sender patterns |
| `social` | Gmail Social label |
| `forum` | Gmail Forums label |
| `list` | `List-Id` or other clear mailing-list signals |
| `automated` | `X-Auto-Response-Suppress`, `Precedence: auto`, other machine-generated indicators |
| `bulk` | `Precedence: bulk`, strong bulk-mail indicators |
| `spam` | Spam/Junk labels, junk indicators |
| `transactional` | Confirmations/receipts/shipping/account records when we can infer them reliably |

This category is:

- deterministic
- rebuildable from maildir/provider metadata
- useful to search, ask, and inbox decisioning
- not itself user policy

### 2. Inbox disposition

The LLM or rules layer should assign a durable inbox disposition to candidate messages:

- `notify`
- `inform`
- `archive`
- `suppress`

These are not just display labels; they are the core decision model that later workflows consume.

### 3. Decision provenance

Each stored decision should record:

- chosen action/disposition
- which rule IDs matched, if any
- optional diagnostics note
- whether the decision came from:
  - explicit rule
  - model
  - cached prior decision
  - fallback path

This is critical for trust and debugging.

---

## State we need

### Local handled state

The system needs a durable local notion of "this message is done."

That should remain a local archive/handled concept:

- setting local `is_archived = 1`
- excluding archived mail from active inbox-oriented workflows by default
- keeping provider-side IMAP writes out of scope here; those remain in [OPP-033](OPP-033-imap-write-operations-and-readonly-mode.md)

### Alert-state vs review-state

This is the major structural clarification after the CLI redesign work:

- **alert state:** has this message already interrupted/notified the user?
- **review state:** has this message already been included in a summary/review?

These should be treated as separate soft-state concepts. Reusing one generic "surfaced" flag for both workflows will blur the semantics again.

### Soft-state on schema bump

The chosen philosophy from [ADR-027](../ARCHITECTURE.md#adr-027-stateful-inbox--no-daemon-soft-state-on-schema-bump) still applies:

- rebuildable state should be rebuilt
- non-rebuildable surfaced state can be lost on schema bump
- after rebuild, the user may get one round of re-surfacing/re-alerting before the soft state re-establishes itself

That is acceptable if the user-facing workflow is otherwise clear and trustworthy.

---

## Storage direction

### Decision table

We need a table for durable inbox decisions keyed by message and decision context.

Representative shape:

```sql
CREATE TABLE IF NOT EXISTS inbox_decisions (
  message_id         TEXT NOT NULL REFERENCES messages(message_id),
  rules_fingerprint  TEXT NOT NULL,
  action             TEXT NOT NULL,      -- notify|inform|archive|suppress
  matched_rule_ids   TEXT NOT NULL DEFAULT '[]',
  note               TEXT,
  decision_source    TEXT NOT NULL,
  decided_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, rules_fingerprint)
);
```

The important properties are:

- durable across repeated agent runs
- tied to a rules/context fingerprint so policy changes can invalidate decisions
- queryable for diagnostics

### Surfaced-state tables

We still need state tables for "this message was already surfaced in a workflow," but the semantics should now evolve toward:

- alert-oriented surfaced state
- review-oriented surfaced state

The exact SQL shape can vary, but it should capture:

- message id
- workflow or surfaced kind
- time surfaced
- scan/review run id

### Message category in `messages`

The deterministic `category` field belongs directly on `messages` because it is rebuildable corpus metadata, not soft state.

---

## Rules and user context

Rules and context should remain file-backed under `~/.zmail/`, not stored only in SQLite.

Suggested rules file shape:

```json
{
  "version": 1,
  "rules": [
    {
      "id": "x9p4",
      "condition": "security alerts from any financial institution",
      "action": "notify"
    },
    {
      "id": "w5j1",
      "condition": "routine shipping and tracking updates unless delivery is today",
      "action": "archive"
    },
    {
      "id": "b3n8",
      "condition": "marketing newsletters from any sender",
      "action": "suppress"
    }
  ],
  "context": [
    {
      "id": "p7a3",
      "text": "Currently closing on a house — mortgage and title emails are high priority until June 2026"
    }
  ]
}
```

Design principles:

- JSON, not prose markdown
- stable short IDs for agent manipulation and diagnostics
- survives DB rebuilds
- stores durable user intent, not derived model output

---

## Diagnostics contract

Any inbox-oriented workflow built on this foundation should be able to expose:

- chosen action
- decision source
- matched rule IDs
- optional reason/note

Diagnostics are essential for:

- prompt tuning
- rule debugging
- understanding fallback behavior
- avoiding silent bad defaults

This should be first-class in the data model even if it is not always shown in the default CLI output.

---

## Relationship to OPP-034

[OPP-034](OPP-034-simplified-inbox-cli-check-review.md) defines the clean-slate user-facing workflows:

- `zmail update`
- `zmail check`
- `zmail review`

OPP-032 defines the lower-level machinery that those workflows depend on:

- categories
- decisions
- rules/context
- archive state
- surfaced-state tracking
- diagnostics

In short:

- **OPP-034** is the UX/product contract
- **OPP-032** is the state model and persistence foundation

---

## Design principles

1. **Separate deterministic metadata from policy.**
   `category` is deterministic/rebuildable. Rules and decisions are policy/state.

2. **Separate disposition from surfaced workflow.**
   `notify|inform|archive|suppress` is the decision model. "Already alerted" and "already reviewed" are workflow state.

3. **Persist user intent outside the DB.**
   Rules and context belong in durable config files.

4. **Treat surfaced-state as soft state.**
   It can reset on rebuild/schema bump.

5. **Make diagnostics first-class.**
   If the model or rules make a bad call, the system should explain why.

---

## Acceptance criteria

### Data model

- `messages` stores a richer deterministic `category`
- inbox decisions are stored durably with provenance
- local archive/handled state is explicit
- surfaced-state exists for inbox workflows and can evolve into separate alert/review tracking

### Rules

- file-backed rules/context survive rebuilds
- each rule has a stable short ID
- decisions can reference matched rule IDs

### Diagnostics

- any inbox decision can expose action + provenance + matched rules + optional note
- fallback behavior is distinguishable from successful model/rule decisions

### Product fit

- this foundation can support the clean-slate CLI from [OPP-034](OPP-034-simplified-inbox-cli-check-review.md)
- this foundation does not force the old overloaded `zmail inbox` mental model to remain

---

## Recommendation

Keep OPP-032, but narrow and clarify its role:

- it is the **stateful inbox foundation**
- not the final user-facing CLI
- not the place to preserve old command semantics

That lets the project evolve cleanly:

- OPP-032 builds the durable inbox substrate
- OPP-034 defines the simplified command surface that users and agents should actually experience
