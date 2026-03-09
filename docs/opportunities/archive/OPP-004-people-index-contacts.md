# OPP-004: People Index and Writable Contacts — "Who" and Agent-Ready Identities

**Status: Implemented (archived).** Milestone 1 (`zmail who`) is delivered; people index at index time, `zmail contact`, and MCP tools are future work.

**Problem:** Email is a graph of people, but today zmail only indexes message content and metadata. There is no first-class notion of "who" — no fast, normalized way to ask "who is Tom?" or "who did Peter mention to me last week?" Sender filtering exists (`--from`), but it requires knowing the exact address. There is no index of every identity that appears in the mailbox (From, To, CC), no canonical "person" record that can be enriched by the user, and no CLI to write or update that metadata. So agents cannot reliably resolve "my dad" or "that person Sarah mentioned" without brittle parsing or multiple search round-trips.

**Example:** A user asks an agent: "Who was that person Peter mentioned to me last week?" Today the agent would have to search for messages from Peter, then try to infer people from snippets or thread participants, with no structured list of identities, no frequency ranking, and no way to attach a note like "my dad is Geoff Cirne" so future queries can use it.

**Vision:** "If it's in any email, it's indexed and instantly agent-ready." A dedicated **people index** is built at index time from every identity that appears in envelope data (From, To, CC). Each identity is a **canonical person** that can hold multiple emails, first/last name, mobile, type (person/business/agent), and user-defined notes (e.g. "my dad"). Users and agents can **write** and **update** this metadata via a CLI (`zmail contact ...`), so the index stays auto-populated from mail but is enriched by human and agent input. A **`zmail who`** command (and corresponding MCP tools) then answers "who is X?" and "who did Y mention?" with one fast, normalized query.

---

## Implemented

### `zmail who` (Milestone 1)

- **Command:** `zmail who <query> [--json] [--limit N] [--min-sent N] [--min-received N]`. Query is required; matching is case-insensitive substring on address or display name.
- **Data source:** Existing `messages` table only (`from_address`, `from_name`, `to_addresses`, `cc_addresses`). No new schema or index-time worker. Sync already populates To/CC for every new message (parse from raw MIME at sync time).
- **Counts (when mailbox owner email is configured in config.json):**
  - **sentCount** — emails **I** sent **to** this person (from = me, person in To/CC).
  - **receivedCount** — emails **I** received **from** this person (from = them).
  - **mentionedCount** — emails where this person was in To/CC but **not** the sender (e.g. Donna sends to Tim and me → Tim is "mentioned").
- **Output:** One row per address; `displayName` is best-known from sender headers (null for to/cc-only). TTY → table; piped or `--json` → `{ "query", "people": [ { "address", "displayName", "sentCount", "receivedCount", "mentionedCount" } ] }`. Order: sent_count DESC, received_count DESC, mentioned_count DESC.
- **Agent-first:** Stable JSON so agents can follow up with `zmail search "from:<address>"` or `zmail read <message_id>`.

---

## Future possibilities

### People index at index time

- A people-indexing pass runs over `messages` and extracts every distinct identity from From/To/CC into a dedicated table (or materialized view) so `zmail who` can query a pre-aggregated index instead of scanning messages.
- **Schema (candidate):** e.g. **people** + **people_emails** (canonical person, multiple emails per person, first/last name, mobile, type, note). Replaces or extends current minimal `contacts`.
- **When it runs:** Separate step after sync, or third concurrent task; status table + lock like `indexing_status`.
- **Exa crossover:** If [Exa integration](../../EXA.md) is present, the enrich worker can populate web-derived fields (company summary, industry, role, one-line bio) per identity. Then `zmail who` / contact show return web-enriched context in one response.

### `zmail contact` — write/update people metadata

- Let users and agents assert canonical person data. "My dad is Geoff Cirne" → `zmail contact set ...`.
- **Verbs (candidate):** `set <selector> [options]`, `link <email> <selector>`, `merge <selector-a> <selector-b>`, `show <selector>`. Options: `--first-name`, `--last-name`, `--mobile`, `--type`, `--note`.

### MCP and body mentions

- Expose **who** (and optionally **contact**) as MCP tools.
- **mentioned_count from body:** Populate from body/text when we have a cheap signal (e.g. name/address extraction in body). Today mentioned_count = "in To/CC but not sender" only; body mentions would add "mentioned in text" as a separate or combined signal.

### Other options

- **No-query behavior:** `zmail who` with no query could return "top N by sent then received" instead of requiring an explicit query.
- **Filters:** `--from <person>`, `--after` / `--before` for time or correspondent scope.

---

## See also

- [EXA.md](../../EXA.md) — Exa.ai integration and **contact/entity enrichment at sync time**. Domain-level ("what is {domain}") and person-level Exa lookups can populate company, industry, and role on the same people/contacts layer this opportunity defines; `zmail who` and `zmail contact show` then return web-enriched context in one response.
