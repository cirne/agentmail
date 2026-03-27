# OPP-029: Compose Voice Context — Sent History and Recipient-Aware Style

**Status:** Not started.

**Relates to:** [OPP-011](OPP-011-send-email.md) (draft + SMTP; remaining “voice profile” bullet), [VISION.md](../VISION.md) (“Voice profile from history”), [OPP-001](OPP-001-personalization.md) (user context for search — complementary personalization surface).

## Problem

Today, LLM compose (`zmail draft new --instruction`, MCP `create_draft` with instruction, and `draft edit`) uses a **generic** system prompt: the model matches tone only if the user spells it out in the instruction. That wastes the richest asset zmail already has — **the user’s own outbound mail**, indexed locally after sync.

Competing products either ignore voice or bolt on static “professional / friendly” presets. zmail can be **special** by assembling **the right local context** at compose time: register that matches how this user writes **to this kind of recipient**, without inventing signatures or leaking unrelated thread content.

## Product impact

Properly assembled extra context could be **transformative** for the send loop:

- Drafts feel **authored**, not templated — the primary interface is the agent; voice is how trust is won.
- **Recipient-aware** retrieval (same person, same domain, or same thread) aligns formality and length with **proven** past behavior.
- It reinforces the core promise: email as a **queryable, personal dataset** — not only for read/ask but for **write**.

## Direction (high level)

Avoid **model fine-tuning** as the default path. Prefer **retrieval + prompt assembly** (and optional **offline distillation** into a small stored profile):

1. **Source of truth:** Messages where `from` matches the configured account (true outbound), after sync into SQLite/maildir. Filter out noise: mostly quoted replies, obvious auto-replies, extreme forwards (heuristics + optional labels).

2. **Retrieval signals (compose-time):**
   - **Same recipients** or **overlapping `To`/`Cc`** — strongest match.
   - **Same domain** — when the person is new, approximate “work vs personal” register.
   - **Same `thread_id`** — when replying, prefer the user’s own prior messages in that thread.
   - **Fallback:** recent outbound sample when buckets are empty (cold start).

3. **Selection / “clustering” (diversity, not vanity k-means):** From candidates, pick a **small** set (e.g. 2–4) that **maximizes stylistic coverage**: mix short vs long, first message in thread vs deep reply, recent vs older — and **minimize redundancy** (simple dedupe by thread/subject or cheap similarity), rather than “top-k most similar.”

4. **What goes in the prompt:**
   - **Truncated style anchors:** e.g. opening line + sign-off region; strict **token budget** per message and total.
   - **Explicit model instruction:** match register, length, and structure; **do not** reuse facts, names, deals, or confidential details from examples.
   - **Optional:** a short **distilled voice blurb** (from a one-time or periodic offline pass) stored under `ZMAIL_HOME` / config — fewer tokens, less PII in every compose call.
   - **Keep distinct from [signatures](OPP-011-send-email.md#key-requirement-configurable-signatures):** signatures remain explicit user-owned config; the model must not invent legal footers or contact blocks.

5. **Privacy and trust:** If examples are sent to an external LLM API, **opt-in** or clear disclosure; optional **redaction** pass (emails, phones); show **counts** (“used 3 messages from your index”) in verbose mode for debuggability.

6. **Refresh model:** Not only “once at setup” — first run after meaningful sync (`zmail compose voice refresh` or automatic cache invalidation on schedule / after N new sent messages). Profile blobs can be cached; raw retrieval can run per compose with caps.

## Scope suggestions

| In scope | Out of scope (initially) |
|----------|---------------------------|
| CLI + shared library used by MCP for `create_draft` / `draft edit` | Fine-tuning OpenAI (or other) models on user mail |
| Recipient/thread/domain-aware SQL + existing search filters | Full RAG with embeddings unless a later opp revives vectors |
| Token caps, truncation, safety instructions in system prompt | IMAP `Drafts` sync |
| Config knobs: enable/disable, max examples, opt-in | Automatic sending without user review |

## Implementation notes (for when picked up)

- **Code touchpoints:** `src/send/compose-new-draft.ts`, `src/send/draft-rewrite.ts`, CLI `src/cli/send-draft.ts`, MCP `src/mcp/index.ts` draft paths.
- **Data:** Reuse `messages` + `from_address` / `to_addresses` / `thread_id` / `date`; align with search’s `fromAddress` / `toAddress` semantics where possible (`src/search/`).
- **No migrations:** Prefer new optional keys in `config.json` and/or a dedicated file under `ZMAIL_HOME` (see [AGENTS.md](../../AGENTS.md) — schema on DB creation only; voice artifacts are config/files, not new SQLite tables unless justified).

## Open questions

- Default **on vs off** for users who already synced large mailboxes?
- **MCP tool** shape: implicit (always retrieve) vs explicit flag `use_voice_context`?
- **Per-recipient** addenda vs single global pool — phase 1 global + domain, phase 2 person?
- **Local-only** distillation (no API) as a future mode for privacy-sensitive users?

## Test coverage (when implemented)

- Unit: candidate query builders (outbound-only, recipient/domain/thread filters), truncation/redaction helpers, token budget enforcement.
- Integration: compose with mocked DB fixtures — assert prompt payload contains expected excerpt boundaries and omits quoted blocks beyond threshold.
- No eval LLM suite required for v1 unless we add quality gates later; optional golden “prompt shape” snapshots (redacted).
