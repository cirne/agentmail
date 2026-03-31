# BUG-029: `zmail read` Fails with `QueryReturnedNoRows` When Message-ID Lacks Angle Brackets — Agent-Reported

**Status:** Fixed (2026-03-31). **Created:** 2026-03-31.

**Resolution:** Central ID resolution in [`src/ids.rs`](../../../src/ids.rs): `message_id_lookup_keys` tries `<id>` first (synced mail), then the bare string (tests and legacy rows). `resolve_message_id`, `resolve_message_id_and_raw_path`, and `resolve_thread_id` drive `zmail read`, `thread`, attachments, MCP (`get_message_by_id`, `get_thread`, `list_attachments`), `draft reply`/`forward`, ask tools/context, and send forward/threading paths. Unit tests cover bracketed-only and bare-fallback rows.

**Design lens:** [Agent-first](../../VISION.md) — Search → read is the core agent pipeline; IDs must round-trip from JSON to CLI without shell or LLM normalization breaking lookups.

**Reported context:** Agent session 2026-03-31, zmail 0.1.0, Darwin 25.4.0, ~26k messages indexed (2025-03-30 .. 2026-03-31). Rust CLI surfaces `Error: QueryReturnedNoRows` (Node historically returned null/empty for the same mismatch — see [BUG-001 archived](BUG-001-attachment-and-read-agent-friction.md)).

---

## Summary (historical)

`zmail search` JSON includes `messageId` values with RFC 5322 angle brackets (e.g. `<uuid@icloud.com>`). When the agent or user passed the **bare** ID without `<>` to `zmail read`, the lookup returned no row.

---

## What the agent did (and what happened)

1. `zmail search "Deployment Failed" --limit 1` → JSON `messageId`: `<1B67114A-8B10-45AD-8630-21BD08A48996@icloud.com>`
2. `zmail read '1B67114A-8B10-45AD-8630-21BD08A48996@icloud.com'` → **Error: QueryReturnedNoRows**, exit 1
3. `zmail read '<1B67114A-8B10-45AD-8630-21BD08A48996@icloud.com>'` → succeeds

Same class of failure as BUG-001 § read/thread exact stored ID: SQLite stores the bracketed form; bare string did not match before the fix.

---

## Root causes

1. **No normalization** of Message-ID / thread ID inputs: CLI expected the exact stored string including `<` and `>`.
2. **Agents strip brackets** when copying from JSON or when treating the ID as a semantic token.
3. **Shell ergonomics:** `<` and `>` are metacharacters; workarounds (`--`, heavy quoting) are easy to get wrong in subshells and pipelines.
4. **Error surface:** `QueryReturnedNoRows` did not hint at bracket normalization.

---

## Recommendations (concise) — addressed

1. **Normalize** at DB boundaries — implemented via `resolve_*` and lookup key order.
2. Clearer errors when no row matches — optional follow-up.
3. **Audit** other commands — covered for read, thread, attachment, draft, MCP, ask.

---

## References

- Vision (agent-first): [VISION.md](../../VISION.md)
- Historical same root cause (broader friction report): [BUG-001 archived](BUG-001-attachment-and-read-agent-friction.md)
- Related prepare/db path (different failure): [BUG-021 archived](BUG-021-read-prepare-error.md)
