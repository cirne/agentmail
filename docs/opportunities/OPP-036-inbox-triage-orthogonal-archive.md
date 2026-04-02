# OPP-036: Inbox Triage Orthogonal to Archive — `notify` / `inform` / `ignore` + Explicit Archive CLI

**Status:** Open. **Created:** 2026-04-02. **Tags:** inbox, triage, archive, cli, imap, rules, safety

**Related:** [OPP-032](OPP-032-llm-rules-engine.md) (stateful inbox substrate; decision storage and provenance), [OPP-034](OPP-034-simplified-inbox-cli-check-review.md) (archived — check/review CLI contract; four-way model superseded here for disposition), [OPP-035](OPP-035-inbox-personal-context-layer.md) (personal context for better `inform`), [ADR-005](../ARCHITECTURE.md#adr-005-dual-agent-interface--native-cli--mcp-server) (CLI + MCP), [ADR-011](../ARCHITECTURE.md#adr-011-email-provider--imap-first-gmail-as-priority-target) (IMAP-first), [ADR-027](../ARCHITECTURE.md#adr-027-stateful-inbox--no-daemon-soft-state-on-schema-bump) (stateful inbox)

**Historical:** Provider-write safety, readonly default, and early `dismiss`-centric examples live in [archive/OPP-033-imap-write-operations-and-readonly-mode.md](archive/OPP-033-imap-write-operations-and-readonly-mode.md). **Track all active work for this initiative in this document (OPP-036).**

---

## Problem

Today, **classification** and **mailbox cleanup** are partially conflated:

- The LLM/rules layer uses four dispositions: `notify`, `inform`, `archive`, `suppress`.
- `archive` both means “do not surface in check/review” **and** sets local `is_archived` during scan side effects, while `suppress` does not — yet neither deletes mail, and the distinction is easy to misinterpret (see inbox scan `apply_decision_side_effects` vs candidate filtering).

Agents and users need a simpler contract:

1. **Triage** answers only: *should this break attention now, appear in the next review summary, or be ignored for proactive surfacing?*
2. **Archive** answers: *should this message leave the local “inbox workload” queue and optionally mirror to the provider?* That is a **separate, explicit** action — not a side effect of classification.

Without that split, “archive” reads like a junk drawer inside the model output, and provider sync (IMAP archive) is harder to attach to a single clear user intent.

---

## Direction

### 1. Three-way triage only (no classifier-driven local archive)

Replace classifier/rule outputs for net-new disposition with:

| Action | Meaning |
|--------|---------|
| `notify` | Interrupt-worthy for `zmail check` (and typically review). |
| `inform` | Worth including in `zmail review` / inbox summary, not check-only urgent. |
| `ignore` | Legitimate mail may remain fully searchable; **do not** proactively surface in check/review. |

**Do not** use triage to set `is_archived`. **Never delete** messages as part of this model; indexing and search retain full history.

Implementation notes:

- Map today’s `archive` and `suppress` **triage intent** into `ignore` (and/or retain deterministic `category` + rule metadata for analytics — orthogonal to archive).
- Update rules prompts, parsers, tests, MCP tool contracts, and any docs that describe `notify|inform|archive|suppress`.
- Cached `inbox_decisions` rows need a migration or compatibility read path if stored actions change (schema bump or normalize on read — follow repo “no migrations” guidance for user DBs: document manual steps or accept resync where appropriate).

### 2. Explicit archive CLI (and MCP parity)

Add a first-class command, e.g.:

```text
zmail archive <message_id> … [--undo] [--json] [--text]
```

- **Default:** set or clear **local** `is_archived` (and keep local state consistent with `inbox_handled` / dismiss semantics if those remain — see below).
- **`--undo`:** unarchive locally (and provider when enabled).

**Relationship to `zmail review dismiss`:** Redefine or narrow dismiss to “mark surfaced item handled” without necessarily conflating it with archive; optionally `dismiss` calls the same internal archive helper when the user wants both, or dismiss stops setting `is_archived` by default in favor of `zmail archive`. Pick one product story and document it in CLI help.

### 3. Optional provider archive (opt-in)

When the user enables mailbox management in config, **`zmail archive` / `--undo`** may also perform the semantic **IMAP archive** (provider-specific: Gmail remove `\\Inbox`, generic IMAP move to Archive folder, etc.).

- **Default remains readonly** on the provider: no IMAP writes unless explicitly enabled.
- Report **local vs provider** results separately (partial success: local archived, provider failed → visible, retryable).

Design detail for config (evolve from historical OPP-033 sketch):

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

## User model (summary)

- **Triage** = attention policy for **new / rescanned** mail (`notify` | `inform` | `ignore`).
- **Archive** = explicit cleanup of the **local** inbox queue, with optional **mirror to server** when opted in.
- **Readonly by default** on IMAP; mailbox management is a deliberate mode.

---

## Phasing

1. **Spec + compatibility:** Define `ignore` vs legacy stored actions; normalization layer for old DB rows.
2. **Rust (and Node parity if required):** Prompts, rules CLI, inbox scan surface matching, remove classifier side effect that sets `is_archived` on `archive` disposition.
3. **`zmail archive` / `--undo`:** Local SQLite behavior, JSON/text output, MCP tool(s).
4. **Config + IMAP:** `mailboxManagement` parsing; provider archive adapter; structured `providerMutation` in output (reuse ideas from archived OPP-033).
5. **Dismiss / review workflow:** Align `review dismiss` with the new archive story; update skills and canonical docs.

---

## Test strategy

- **Unit:** `normalize_action` / disposition parsing; migration or read-path for legacy four-way actions.
- **Unit:** Archive and unarchive update `messages.is_archived` correctly; idempotent or clearly reported replays.
- **Integration:** `check` surfaces only `notify`; `review` surfaces `notify` + `inform`; `ignore` never surfaces.
- **Integration:** Classifier batch does not flip `is_archived` — only `zmail archive` (or explicit dismiss policy) does.
- **Integration:** Readonly config → archive is local only; `providerMutation.attempted === false`.
- **Integration:** Mailbox management enabled → archive attempts IMAP; partial failure surfaces in JSON.
- **Docs:** SKILL / AGENTS pointers updated when CLI stabilizes.

---

## References

- [archive/OPP-033-imap-write-operations-and-readonly-mode.md](archive/OPP-033-imap-write-operations-and-readonly-mode.md) — historical IMAP write and safety notes (superseded as the active tracker by this doc)
- [OPP-032](OPP-032-llm-rules-engine.md) — durable decisions, rules fingerprint, surfaced state
- [ADR-027](../ARCHITECTURE.md#adr-027-stateful-inbox--no-daemon-soft-state-on-schema-bump) — stateful inbox decisions
