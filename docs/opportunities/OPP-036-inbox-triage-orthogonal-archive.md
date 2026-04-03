# OPP-036: Inbox Triage Orthogonal to Archive — `notify` / `inform` / `ignore` + Explicit Archive

**Status:** Open. **Created:** 2026-04-02. **Updated:** 2026-04-02. **Tags:** inbox, triage, archive, cli, imap, rules, safety, bootstrap

**Related:** [OPP-032](OPP-032-llm-rules-engine.md) (stateful inbox substrate; decision storage and provenance), [OPP-034](OPP-034-simplified-inbox-cli-check-review.md) (archived — check/review CLI contract; four-way model superseded here), [OPP-035](OPP-035-inbox-personal-context-layer.md) (personal context for better `inform`), [ADR-005](../ARCHITECTURE.md#adr-005-dual-agent-interface--native-cli--mcp-server) (CLI + MCP), [ADR-011](../ARCHITECTURE.md#adr-011-email-provider--imap-first-gmail-as-priority-target) (IMAP-first), [ADR-027](../ARCHITECTURE.md#adr-027-stateful-inbox--no-daemon-soft-state-on-schema-bump) (stateful inbox)

**Historical:** Provider-write safety, readonly default, and early `dismiss`-centric examples live in [archive/OPP-033-imap-write-operations-and-readonly-mode.md](archive/OPP-033-imap-write-operations-and-readonly-mode.md). **Track all active work for this initiative in this document (OPP-036).**

---

## Problem

Today, **classification** and **mailbox cleanup** are partially conflated:

- The LLM/rules layer uses four dispositions: `notify`, `inform`, `archive`, `suppress`.
- `archive` both means “do not surface in check/review” **and** sets local `is_archived` during scan side effects (`apply_decision_side_effects`), while `suppress` does not — the distinction is easy to misinterpret.
- A second mechanism, **`inbox_handled`**, plus **`zmail review dismiss`**, overlaps with **`is_archived`** for “remove from proactive inbox” (candidate loading filters on both), which is **error-prone** for users and agents (“dismiss or archive?”).

Agents and users need a simpler contract:

1. **Triage** answers only: *should this break attention now, appear in the next review summary, or be ignored for proactive surfacing?*
2. **Archive** answers: *should this message leave the local “inbox workload” queue* (`is_archived`) *and optionally mirror to the provider?* That must be a **separate, explicit** action — not a side effect of everyday classification.

---

## Direction

### 1. Three-way triage (`notify` / `inform` / `ignore`)

Replace net-new classifier/rule disposition with:

| Action | Meaning |
|--------|---------|
| `notify` | Interrupt-worthy for `zmail check` (and typically review). |
| `inform` | Worth including in `zmail review` / inbox summary, not check-only urgent. |
| `ignore` | Legitimate mail remains fully searchable; **do not** proactively surface in check/review. |

Map former triage intent **`archive`** and **`suppress`** → **`ignore`** in prompts, parsers, `rules.json` actions, SQLite `inbox_decisions` CHECK, and tests.

**Never delete** messages; indexing and search retain full history.

### 2. When classification sets `is_archived`

- **Normal `check` / `review`:** After persisting decisions, any message classified **`ignore`** is **`is_archived = 1`** automatically (still fully searchable). **`notify`** / **`inform`** stay unarchived until the user/agent runs **`zmail archive`** after handling or surfacing.
- **Rules preview (`preview_rule_impact`):** does **not** persist decisions or flip `is_archived` (dry classification only).
- **Post-rebuild bootstrap (see §5):** additionally bulk-archives by **message age**, then classifies the recent unarchived slice — same **`ignore` → archived** behavior as everyday scans.

### 3. Archive-only user workflow — remove `inbox_handled` and `review dismiss`

- **`messages.is_archived`** removes mail from the **unarchived proactive working set**. **`ignore`** triage does this automatically on each scan; **`zmail archive`** is for mail that was **surfaced** (`notify` / `inform`) once the user/agent is done with it.
- **Remove** the **`inbox_handled`** table and **`zmail review dismiss`**. No second parallel state machine.
- **`zmail archive`** / **`--undo`:** only toggles **`is_archived`** locally (plus optional provider mutation when enabled).

**Note:** **`inbox_alerts`** / **`inbox_reviews`** still record “already surfaced” and exclude messages from later candidate passes unless **`--replay`**. That is independent of removing `inbox_handled`. If the desired UX is “every `review` lists all unarchived `inform` mail every time,” that requires a follow-up change to surfaced-history behavior — not implied by dropping `inbox_handled` alone.

### 4. Explicit `zmail archive` CLI (and MCP parity)

```text
zmail archive <message_id> … [--undo]
```

- **Default:** set **local** `is_archived = 1` for each id.
- **`--undo`:** set **local** `is_archived = 0` (and provider when enabled).

Add MCP tool(s) with the same semantics; update [docs/MCP.md](../MCP.md) and `TOOL_NAMES` / stable schema count.

### 5. Post-rebuild inbox bootstrap (clean slate + small working set)

**Goal:** After **`zmail rebuild-index`** (and the same behavior for **schema-drift maildir rebuild** if applicable), start from a **clean inbox state** and land in a **small, actionable** unarchived set: recent mail only, further trimmed by triage.

**Steps (conceptual):**

1. **Clean slate:** Clear **`inbox_scans`**, **`inbox_alerts`**, **`inbox_reviews`**, **`inbox_decisions`** (no `inbox_handled`).
2. **Age cutoff:** Bulk-set **`is_archived = 1`** for messages whose **`date`** is older than **`now - window`**; default window **1 day** (UTC recommended; compare consistently with stored ISO dates). Optional config, e.g. `inbox.bootstrapArchiveOlderThan` or alignment with `inbox.defaultWindow` — document in code and AGENTS.
3. **Classify recent unarchived mail:** Run the batch classifier on the remaining **`is_archived = 0`** messages (the recent slice); persist **`inbox_decisions`**.
4. For each message with action **`ignore`**, set **`is_archived = 1`** (same as everyday **`run_inbox_scan`**). Do **not** auto-archive **`notify`** / **`inform`**.

**Result:** All mail stays indexed and queryable; **proactive** flows focus on **unarchived** mail, mostly **last day**, biased toward **`notify` / `inform`**.

**Optional:** Call the same bootstrap helper on **first successful sync** of a brand-new DB if product wants parity without a manual rebuild — define carefully to avoid repeated LLM cost on every sync.

**Operational:** Bootstrap may issue **many LLM calls**; log counts and duration.

### 6. Optional provider archive (opt-in)

When the user enables mailbox management in config, **`zmail archive` / `--undo`** may also perform **IMAP archive** (Gmail vs generic IMAP semantics per [archive/OPP-033](archive/OPP-033-imap-write-operations-and-readonly-mode.md)).

- **Default remains readonly** on the provider.
- Report **local vs provider** separately (`providerMutation`: attempted, ok, error); partial success must be visible and retryable.

```json
{
  "mailboxManagement": {
    "enabled": false,
    "allow": ["archive"]
  }
}
```

Start with a boolean if simpler; leave room for per-action gates.

---

## Schema and data lifecycle

- Bump **`SCHEMA_VERSION`**: new **`inbox_decisions`** actions **`notify` | `inform` | `ignore`** only; **drop `inbox_handled`**.
- **No legacy index migration** for stored decisions (current assumption: **no install base** requiring in-place migration). Rely on **schema bump + maildir rebuild**; omit or sanitize **`inbox_decisions`** on snapshot restore if CHECK would fail.

---

## User model (summary)

| Concept | Meaning |
|---------|---------|
| **Triage** | Attention policy: `notify` \| `inform` \| `ignore`. **`ignore` → `is_archived` on scan**; surfaced mail uses **`zmail archive`** when done. |
| **Archive** | **`zmail archive`** / **`--undo`**: local `is_archived` for surfaced (or any) message ids; optional provider mirror when enabled. |
| **Working set** | Unarchived messages (plus triage/surfaced filters). |
| **Bootstrap** | One-shot after rebuild: clear inbox tables, bulk-archive by age, classify recent slice ( **`ignore` → archived** same as normal). |

**Readonly by default** on IMAP; mailbox management is deliberate.

---

## Phasing

1. **Schema + rebuild path:** Bump version; drop `inbox_handled`; tighten `inbox_decisions` CHECK; snapshot/rebuild behavior per §Schema above.
2. **Rust triage:** Prompts, parsers, rules CLI, surface matching; remove legacy classifier archive path; **`ignore` → `is_archived`** after persist on every **`run_inbox_scan`**; bootstrap adds age bulk-archive + inbox table reset.
3. **`zmail archive` / `--undo`:** Local SQLite, JSON on stdout; remove **`review dismiss`**; MCP tool(s).
4. **Config + IMAP:** `mailboxManagement` parsing; provider archive adapter; structured output.
5. **Docs:** AGENTS, SKILL, RELEASING notes for breaking CLI/schema; optional Node parity only if required by [RUST_PORT.md](../RUST_PORT.md).

---

## Test strategy

- **Unit:** `normalize_action` / disposition parsing; canonical three values persisted; defensive coercion of stray model tokens before insert.
- **Unit:** `zmail archive` / `--undo` and `is_archived` idempotence.
- **Integration:** `check` surfaces only `notify`; `review` surfaces `notify` + `inform`; `ignore` never in surfaced output lists.
- **Integration:** **`ignore`** after classify sets **`is_archived`** on normal scans; bootstrap also archives by age before classifying the recent slice.
- **Integration:** No `inbox_handled` rows; no `review dismiss` command.
- **Integration:** Readonly config → `providerMutation.attempted === false`; mailbox management enabled → IMAP attempted; partial failure in JSON.
- **Docs:** SKILL / AGENTS / MCP when CLI stabilizes.

---

## References

- [archive/OPP-033-imap-write-operations-and-readonly-mode.md](archive/OPP-033-imap-write-operations-and-readonly-mode.md) — IMAP write safety and provider semantics (historical detail; active tracker is this doc)
- [OPP-032](OPP-032-llm-rules-engine.md) — durable decisions, rules fingerprint, surfaced state
- [ADR-027](../ARCHITECTURE.md#adr-027-stateful-inbox--no-daemon-soft-state-on-schema-bump) — stateful inbox decisions
