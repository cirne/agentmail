# BUG-017: Semantic Recall Gap for Intent-Based Queries — Agent-Reported

**Status:** Open. **Resolution path confirmed by Bakeoff #5 (2026-03-07)** — FTS + agent query decomposition fixes this. The root cause is semantic search as the default, not a fundamental search recall problem. See [OPP-019 archived](../../opportunities/archive/OPP-019-fts-first-retire-semantic-default.md).

**Design lens:** [Agent-first](../../VISION.md) — When a user asks a vague, intent-based question like "who is that entrepreneur I met last week?", zmail must connect signal across heterogeneous email types (Zoom invites, Otter.ai shares, follow-up emails, investor intros). Missing a person who exists in the data is a quality failure that makes zmail unreliable for personal memory queries.

**Reported context:**
- **Bakeoff #2 (2026-03-07):** "who is that entrepreneur i met with last week?". zmail found Trey Moore (Feb 26) but missed Marcio Nunes (Harmonee AI, Mar 3) despite the data being in sync range. Gmail found Marcio Nunes. The meeting evidence for Marcio was spread across: a Zoom invite, an Otter.ai meeting summary share, and an investor introduction chain.

---

## Summary

For vague, intent-based queries ("entrepreneur I met"), zmail's semantic search fails to surface relevant emails when the evidence is distributed across heterogeneous email types that use different vocabulary. A Zoom invite, an Otter.ai "here's your meeting summary" email, and a "great connecting today" follow-up are all signals for the same meeting — but none individually contains the word "entrepreneur." Gmail found Marcio by running 6 different keyword searches (meetings, calendar, entrepreneur, Zoom, etc.); zmail ran fewer, more targeted semantic searches and missed him.

The miss is not a sync issue — Marcio's emails were in the sync range. It is a recall gap: the embedding for "who is the entrepreneur I met last week" did not rank Zoom notifications or Otter.ai shares highly enough to surface them in the top-N.

---

## What the agent did (and what happened)

**Query:** "who is that entrepreneur i met with last week?"

| | zmail | Gmail MCP |
|---|---|---|
| Found | Trey Moore / Mission 3A (Feb 26) | Marcio Nunes / Harmonee AI (Mar 3) |
| Missed | Marcio Nunes (Mar 3) | Trey Moore (Feb 26) |
| Tool calls | 9 (semantic searches + thread reads) | 12 (6 searches, breadth strategy) |
| Wall-clock | ~66s | ~74s |

zmail ran targeted semantic searches for "entrepreneur meeting" but did not surface the Zoom invite, Otter.ai share, or investor intro for Marcio. Gmail's brute-force breadth (6 different keyword searches) caught what semantic search missed.

Neither tool found both entrepreneurs — which reveals a fundamental recall problem for this query type.

---

## Root causes

### 1. Semantic embedding mismatch for meeting-type signals

Zoom notifications ("You have a Zoom meeting with Marcio Nunes at 2pm") and Otter.ai shares ("Here's the AI-generated summary of your meeting") do not contain the word "entrepreneur." Their embeddings cluster around "meeting logistics," not "entrepreneurial conversation." A semantic query for "entrepreneur I met" has low cosine similarity to these emails.

FTS5 keyword search also fails: FTS on "entrepreneur" only matches emails that literally contain that word.

### 2. No cross-email signal aggregation

The meeting evidence is split: invite + Otter.ai share + follow-up + investor intro. Each alone is a weak signal. Together they clearly identify a significant entrepreneurial meeting. zmail has no mechanism to cluster or cross-reference related emails by time/person proximity before ranking them.

### 3. Top-N truncation kills recall for intent queries

The semantic search fetches top-100 from LanceDB and slices to the limit (default 10). If Marcio's Zoom invite ranks at position 60 in the embedding space (because the query embedding is closer to "meeting" emails from other people), it is discarded before the merge.

### 4. No intent classification to adjust retrieval strategy

"Find the entrepreneur I met" is an exhaustive-recall query (like the Apple receipts query in BUG-016). The agent needs ALL meeting-type emails from last week, not just the statistically most relevant one. Using relevance search for this is the wrong tool — the right tool is a time-scoped "show me all Zoom/meeting/Otter.ai emails from last 7 days" filter query.

---

## Recommendations

1. **Meeting-type email boosting**: When query intent signals a person/meeting search (keywords: "met", "meeting", "called", "talked to", "connected with"), boost emails from known meeting senders (Zoom, Otter.ai, Calendly, Google Meet, etc.) in the result set.

2. **Time-proximity clustering**: Group emails by sender+timewindow into "meeting events" — a Zoom invite, Otter.ai share, and "great connecting" follow-up that all mention the same person within 24 hours of each other should be returned as a cluster, not ranked independently.

3. **`zmail meetings` command** (or `--intent meeting` flag): A dedicated meeting-retrieval path that queries Zoom/calendar/Otter.ai senders for a given time range and groups results by meeting event. This is the exhaustive enumeration path for meeting queries.

4. **Increase fetch limit for intent queries**: When the query is vague/intent-based, fetch 3x more candidates from both FTS and semantic, then let the LLM agent (not the search engine) do the final ranking. The search engine can't always know which emails are relevant for abstract intents.

5. **Surface related emails in thread/who context**: When returning a person match, include their most recent Zoom/meeting emails as related context — even if they didn't rank in the semantic top-N.

---

## Bakeoff #5 Update — Resolution Path Confirmed

In Bakeoff #5 (rematch, FTS-only), all three zmail interfaces found Marcio Nunes. The agents decomposed the vague query into keyword-rich searches (`"meeting OR zoom OR call"`, `"entrepreneur OR startup OR founder"`), which FTS matched instantly. zmail MCP even found a second entrepreneur (Sarah Findlay) that Gmail missed.

**The fix for BUG-017 is not to improve semantic search — it's to stop relying on it as the default.** With FTS as the default, agents naturally do query decomposition that covers the vocabulary space semantic embeddings were supposed to cover. See [OPP-019 archived](../../opportunities/archive/OPP-019-fts-first-retire-semantic-default.md).

## References

- Vision (agent-first): [VISION.md](../../VISION.md)
- Related architecture: BUG-016 (exhaustive enumeration gap — same root problem for different query type)
- Bakeoff failure: `../ztest/feedback/submitted/bakeoff-002-entrepreneur-meeting.md`
- Bakeoff confirmation: `../ztest/feedback/submitted/bakeoff-005-entrepreneur-rematch.md`
- Resolution: [OPP-019 archived](../../opportunities/archive/OPP-019-fts-first-retire-semantic-default.md) — FTS-first architecture
- Relevant code: `src/search/index.ts` — `searchWithMeta`, `vectorSearchFromEmbedding`
