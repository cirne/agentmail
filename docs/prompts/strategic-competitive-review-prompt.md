# Strategic & Competitive Review Prompt

**Use this prompt with a deep learning / research agent to get a comprehensive strategic and competitive analysis of the agent-first email landscape. Copy the entire "Prompt" section below.**

---

## Prompt

You are a strategic analyst. Perform a comprehensive strategic and competitive review of the **agent-first / AI-accessible email** landscape and advise whether the open-source project described below is worth pursuing or should be shelved in favor of other efforts.

**Context:** Software is cheap to build; differentiation and timing matter. I need a clear picture of who offers what today, what is genuinely unique about this project, and whether the opportunity is real or crowded out.

---

### 1. Research the current landscape (use latest news and sources)

- **Incumbents:** What are Gmail, Outlook, and other major providers offering in 2024–2025 for AI/agent access to email? (APIs, Copilot, Gemini integrations, native AI features.) How do they position “AI email” — reactive suggestions vs. programmatic/agent access?
- **Startups and tools:** Who else is building “AI email” or “agent email” products? Include: API proxies or CLIs that wrap Gmail/Outlook APIs, autonomous email agents (e.g. Jace, Revo, Fyxer), and any “local” or “privacy-first” email index/search tools. What do they do and what do they *not* do (e.g. keyword-only search, no attachment content search, no semantic search)?
- **Developer/agent integrations:** What exists for giving AI coding agents (Claude Code, Cursor, OpenClaw, etc.) access to email? MCP servers, plugins, CLIs, hosted APIs? Which are provider-specific vs. provider-agnostic?
- **Trends:** Is the market moving toward more agent-first / programmatic email access, or staying human-inbox-centric? Any recent funding, acquisitions, or product launches that change the landscape?

---

### 2. Understand the project in question: zmail

**Positioning:** zmail is an **agent-first email system** — not another inbox UI. It reimagines email as a **queryable dataset and filesystem-like repository** where the primary interface is **tools and APIs for AI agents**; the human UI is optional. Goal: “Never have to look at your inbox again.” The agent (e.g. Claude Code, OpenClaw) is the interface; you read and (in the vision) write through it.

**Current capabilities (as of 2025):**

- **Sync:** IMAP sync from any provider (Gmail, Outlook, Fastmail, etc.). User keeps their existing address; no deliverability risk. Sync is clone/copy mode: zmail is an intelligence layer in front of the provider, not a replacement.
- **Storage:** Local-first. Raw mail in Maildir-style files; SQLite for metadata and indexes; optional LanceDB for vectors. Data stays on the user’s machine (or their self-hosted container).
- **Search:** Hybrid search: FTS5 (keyword) + semantic (embeddings, LanceDB) with reciprocal-rank fusion. Query supports operators: `from:`, `to:`, `subject:`, `after:`, `before:`, and free text. **Observed performance** (see `docs/PERFORMANCE.md`): FTS-only and filter-only &lt;5ms in-process; hybrid keyword ~15ms; semantic cold (embedding API) ~200–400ms total. No provider rate limits; works offline after sync.
- **Attachment intelligence:** Attachments (PDF, DOCX, XLSX, HTML, CSV, TXT) are extracted to text/markdown at sync time and indexed with message bodies. Agents can search inside attachments (“find the NDA with the indemnification clause”) without download–open–read loops. Single tool call can list, read, or search attachment content.
- **Agent interfaces:**  
  - **CLI:** `zmail search "query"`, `zmail read <id>`, `zmail thread <id>`, `zmail who <query>`, `zmail attachment list/read`, etc. JSON by default for machine consumption.  
  - **MCP server:** `zmail mcp` runs a Model Context Protocol server (stdio) with tools: `search_mail`, `get_message`, `get_thread`, attachment tools, etc. Same SQLite index as CLI.
- **Scope today:** Read-only. No send yet. Send (draft + SMTP via user’s provider) is in the vision and explicitly blocked until “customer validation” for core search/index/onboarding is done.

**Planned / vision (not yet built):**

- **Send:** SMTP send-as-user through existing provider; “voice profile” from sent history so drafts sound like the user; intent-to-action (e.g. “RSVP yes” → agent finds invite, drafts, confirms, sends). No inbox, no compose window — agent as interface.
- **Broader communication graph:** Email plus Slack, Google Docs, Notion, Zoom transcripts, etc., as one AI-queryable corpus.
- **Deployment:** Self-hosted Docker as primary; optional future hosted indexing/API. Open source core.

**Explicit strategic differentiators (from the project’s own strategy doc):**

- **Not an API proxy.** It does not forward queries to Gmail/Outlook. It syncs mail locally and builds a local index. So: semantic search over full corpus, attachment content in the index, no per-query network round-trips, no provider rate limits, multi-provider unification (one index across Gmail + Outlook + Fastmail), privacy (queries never leave the machine), offline capability.
- **Architectural moat:** An API proxy cannot add local semantic search, attachment content indexing, or sub-10ms queries without becoming a local intelligence layer — a different product. The claim is that “zmail is the intelligence layer between email providers and AI agents.”

**Performance metrics (hard data for differentiation):**

Measured on a live index (~2K messages); see `docs/PERFORMANCE.md` for methodology and more examples.

| Operation | Observed latency (in-process) | Note |
|-----------|------------------------------|------|
| FTS-only search (keyword) | **2 ms** | e.g. `zmail search "invoice" --fts` |
| Hybrid search (keyword + semantic, embedding cached/fast) | **12–15 ms** | FTS 0–1 ms, vector 9–12 ms |
| Filter-only (e.g. `after:7d`) | **2 ms** | No text query |
| People lookup (`zmail who`) | **5–35 ms** | e.g. 35 ms for 4 people, 5 ms empty |
| Semantic cold (first-time query embedding) | **~200–400 ms total** | Dominated by OpenAI embedding API; FTS + vector + merge &lt;20 ms |

**Comparison frame:** Provider APIs (e.g. Gmail) are typically cited at 200–500 ms per query round-trip and are rate-limited. A 10-query agent workflow: API proxy ~2–5 s; local index (keyword/who) **&lt;100 ms** in-process. Use these figures when assessing “speed as a differentiator” and when comparing to API-proxy or hosted solutions.

---

### 3. Your analysis tasks

1. **Landscape summary:** Who offers what in “AI/agent email” today? Categorize by: (a) provider-native (Gmail, Outlook, etc.), (b) API-proxy / thin wrappers, (c) autonomous agents (inbox triage, drafting), (d) local or self-hosted index/search. For each category, what can they do and what can they *not* do (e.g. semantic search, attachment content search, multi-provider, latency, privacy)?
2. **Gap analysis:** Given the landscape, what is **genuinely unique** about zmail’s current capabilities and its vision? What can only (or best) be done with a local, sync-and-index architecture like zmail’s? Use the **performance metrics** above (2 ms FTS, 12–15 ms hybrid keyword, 5–35 ms who vs. 200–500 ms typical API round-trips) when assessing whether “speed as a differentiator” is real and defensible.
3. **Threats and headwinds:** Could incumbents (e.g. Google, Microsoft) offer semantic search, attachment indexing, or agent APIs in a way that obviates zmail? Could a well-funded startup replicate the local-index approach and capture the “agent-first email” narrative? What would make zmail redundant?
4. **Opportunity assessment:** Is “agent-first email as a queryable dataset” a real, timing-relevant opportunity? Who is the ideal user (e.g. knowledge workers using Claude Code/Cursor, power users, enterprises)? Is the problem (inbox overload, slow search, no programmatic access) important enough and poorly enough served that a local-first, open-source project can win a durable niche?
5. **Recommendation:** Should the maintainers **continue investing** in zmail (and if so, what should they prioritize), or **shelve it** and put effort elsewhere? Be explicit. If shelve, under what conditions might it be worth revisiting?

---

### 4. Output format

- Start with a one-paragraph executive summary and a clear recommend: pursue or shelve (and nuance if needed).
- Then: landscape summary, gap analysis, threats, opportunity assessment, and detailed recommendation with priorities or conditions.
- Cite sources where possible (product pages, announcements, articles). If you cannot find recent sources, say so and base analysis on the descriptions above and general market knowledge.

---

*This prompt was generated from zmail’s docs (VISION.md, STRATEGY.md, ARCHITECTURE.md, MCP.md, AGENTS.md, PERFORMANCE.md) to accurately represent current capabilities and vision.*
