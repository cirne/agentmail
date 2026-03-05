# Product Opportunities

Improvement ideas discovered through real usage. Each entry captures the problem, a concrete example, and a proposed direction.

See [VISION.md](./VISION.md) for product vision, [ARCHITECTURE.md](./ARCHITECTURE.md) for technical decisions.

---

## OPP-001: Personalization — User Context for Search

**Problem:** Keyword search (FTS) and even semantic search miss results when the user's personal vocabulary differs from the text in their emails. A query like _"what's going on at the ranch"_ returns nothing useful when the ranch-related emails use project names ("Son Story"), building codes ("SS2", "SS8"), or activity terms ("shooting range", "pond", "driveway") instead of the word "ranch."

**Example:** Weekly construction updates from a ranch manager (Tim Drell, tdrell@greenlonghorninc.com) about buildings, pools, shooting ranges, and driveways were invisible to a search for "ranch" because the emails never used that word — they referred to the property as "Son Story."

**Proposed direction:** Introduce a user-defined personalization layer — a set of notes, aliases, and context the user provides about their world:

```
- "Son Story" is my ranch near Austin, TX
- Tim Drell (tdrell@greenlonghorninc.com) is the ranch manager
- SS2 and SS8 are buildings on the ranch
- "Cottonwood" is the main house on the ranch
```

This context would be incorporated at **two points**:

1. **Index time** — enrich embeddings and/or FTS tokens with user-provided aliases so that "Son Story" content also matches "ranch" queries.
2. **Search time** — expand or rewrite queries using the personalization context (e.g., "ranch" → also search for "Son Story", "SS2", "SS8", messages from tdrell@greenlonghorninc.com).

**Open questions:**
- Where does the user store these notes? A config file, a UI, or conversational input via the agent?
- How to keep the context up to date as new projects/people appear?
- Should the agent be able to learn and propose new context entries from patterns it observes?
