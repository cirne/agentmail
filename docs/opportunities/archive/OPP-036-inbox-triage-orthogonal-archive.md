# OPP-036: Inbox Triage Orthogonal to Archive — `notify` / `inform` / `ignore` + Explicit Archive

**Status:** Archived — **core implemented** (2026-04-04). **Created:** 2026-04-02. **Updated:** 2026-04-04. **Tags:** inbox, triage, archive, cli, imap, rules, safety, bootstrap

**Replaces / clarifies:** Earlier conflation of triage dispositions with **`is_archived`**, parallel **`inbox_handled`** / **`review dismiss`** flows, and the interim **`update` / `check` / `review`** CLI experiment ([OPP-034](../OPP-034-simplified-inbox-cli-check-review.md) — itself **superseded** by **`zmail refresh`**, **`zmail inbox`**, **`zmail rules`**, **`zmail archive`**).

**Superseded in part by:** [OPP-037](OPP-037-typed-inbox-rules-eval-style.md) — triage classification is **deterministic** (no LLM batch); bootstrap no longer implies “many LLM calls.”

**Related:** [OPP-032](../OPP-032-llm-rules-engine.md) (substrate), [OPP-034](../OPP-034-simplified-inbox-cli-check-review.md) (archived CLI sketch — historical), [OPP-035](../OPP-035-inbox-personal-context-layer.md) (remaining personalization), [OPP-033](OPP-033-imap-write-operations-and-readonly-mode.md) (IMAP write semantics — historical), [ADR-005](../ARCHITECTURE.md#adr-005-dual-agent-interface--native-cli--mcp-server), [ADR-011](../ARCHITECTURE.md#adr-011-email-provider--imap-first-gmail-as-priority-target), [ADR-027](../ARCHITECTURE.md#adr-027-stateful-inbox--no-daemon-soft-state-on-schema-bump)

**Remaining work (narrower trackers):** Personal context layer ([OPP-035](../OPP-035-inbox-personal-context-layer.md)); optional provider-archive polish and mailbox-management edge cases (see OPP-033 historical doc).

---

## Problem (historical — pre–smart-inbox merge)

**Classification** and **mailbox cleanup** were partially conflated:

- The LLM/rules layer used four dispositions: `notify`, `inform`, `archive`, `suppress`.
- `archive` both meant “do not surface in check/review” **and** set local `is_archived` during scan side effects, while `suppress` did not — easy to misinterpret.
- **`inbox_handled`** plus **`zmail review dismiss`** overlapped with **`is_archived`** (“dismiss or archive?”).

**Current product (implemented):** Three-way triage only; **`zmail archive`** is explicit; proactive surfacing uses **`zmail inbox`** (not `check`/`review`). See **User model** below.

---

## Direction (implemented)

### 1. Three-way triage (`notify` / `inform` / `ignore`)

| Action | Meaning |
|--------|---------|
| `notify` | Interrupt-worthy / urgent surfacing in **`zmail inbox`** output. |
| `inform` | Summary-worthy in **`zmail inbox`**, not only urgent. |
| `ignore` | Legitimate mail stays searchable; do not proactively surface; scan may set **`is_archived`** per policy. |

Former **`archive`** / **`suppress`** dispositions in rules → map to **`ignore`** where applicable.

### 2. When classification touches `is_archived`

- **`ignore`** after classify may set **`is_archived`** (working-set hygiene); **`notify`** / **`inform`** stay unarchived until **`zmail archive`** when the user/agent is done.
- **Rules preview** does not persist or flip **`is_archived`**.
- **Post-rebuild bootstrap:** age-based bulk archive + classify recent unarchived slice ([`src/inbox/bootstrap.rs`](../../../src/inbox/bootstrap.rs)).

### 3. Archive-only workflow

- **`zmail archive`** / **`--undo`**: toggles **`messages.is_archived`** locally; optional provider mutation when **`mailboxManagement`** is enabled.
- **`inbox_handled`** / **`review dismiss`** removed from the CLI story.

### 4. Explicit `zmail archive` CLI + MCP

**`archive_mail`** MCP tool — see [MCP.md](../../MCP.md).

### 5. Post-rebuild inbox bootstrap

Clean inbox tables, bulk-archive by age, classify recent slice — **without LLM cost** (deterministic classifier).

### 6. Optional provider archive

Opt-in **`mailboxManagement`**; readonly-by-default IMAP — details in [OPP-033](OPP-033-imap-write-operations-and-readonly-mode.md).

---

## Schema and data lifecycle (implemented)

**`SCHEMA_VERSION`** bumped; **`inbox_decisions`** actions **`notify` \| `inform` \| `ignore`**; drift → maildir rebuild per project policy.

---

## User model (summary) — current

| Concept | Meaning |
|---------|---------|
| **Triage** | Attention policy: `notify` \| `inform` \| `ignore`. Surfacing via **`zmail inbox`**. |
| **Archive** | **`zmail archive`** / **`--undo`**: local `is_archived`; optional provider mirror. |
| **Working set** | Unarchived messages (plus triage / surfaced-history filters). |
| **Bootstrap** | Post-rebuild: reset inbox tables, age bulk-archive, classify recent slice. |

---

## Phasing (complete)

Phases 1–3 and docs (**AGENTS**, skill, **MCP**) shipped with the smart-inbox branch. Optional Node parity remains [RUST_PORT.md](../RUST_PORT.md).

---

## Test strategy

**Integration:** Prefer **`zmail inbox`** JSON/text tests over legacy `check`/`review` naming. **`zmail archive`** / **`--undo`** idempotence; readonly vs mailbox-management provider fields in JSON.

---

## References

- [OPP-033](OPP-033-imap-write-operations-and-readonly-mode.md) — IMAP write safety and provider semantics (historical detail)
- [OPP-032](../OPP-032-llm-rules-engine.md) — durable decisions, rules fingerprint, surfaced state
- [OPP-037](OPP-037-typed-inbox-rules-eval-style.md) — deterministic rule evaluation (inbox)
- [ADR-027](../ARCHITECTURE.md#adr-027-stateful-inbox--no-daemon-soft-state-on-schema-bump) — stateful inbox decisions
