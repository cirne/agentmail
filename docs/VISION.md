# Agent-First Email
## Vision

> Architectural decisions and the technical design log live in [ARCHITECTURE.md](./ARCHITECTURE.md).
> Competitive positioning and strategic differentiation live in [STRATEGY.md](./STRATEGY.md).
> Unit economics and cost modeling live in [COGS.md](./COGS.md).
> Product improvement opportunities live in [OPPORTUNITIES.md](./OPPORTUNITIES.md).

### Summary

Modern email systems (Gmail, Outlook, etc.) are **human-first interfaces** designed around inbox browsing and manual workflows.

They are poorly suited for the emerging world of **AI agents and programmatic interaction**.

Agent-First Email reimagines email as a **queryable dataset and filesystem-like repository of communication artifacts**, where the primary interface is **tools and APIs for agents**, and the human UI is optional.

Instead of browsing inboxes, agents **query communication graphs**.

**User promise:** zmail lets you **never have to look at your inbox again**. Inbox infinity instead of inbox zero — you stop fighting to empty the inbox because the system is agent-first and **lightning-fast searchable**. Your email becomes an asset again: you actually *want* everything in your email because it’s **actionable** — Zoom meeting notes, travel confirmations, automated invoices, receipts, and more, all **agent-ready** because they live in your mail. Tools like Claude Code or OpenClaw **just work** once zmail is installed: the LLM turns your natural-language prompts into the right zmail queries, fetches the data, and assembles the answer.

**End state:** zmail + agent harness (Claude Code, OpenClaw, etc.) = **never open your inbox or send an email again**. The agent is the interface. You read through it. You write through it.

---

# “Just works” in the agent (reliably, fast)

When you’re in Claude Code (or another coding agent) with zmail wired up, these kinds of prompts should **just work** — the agent uses zmail tools to fetch the right mail and then answers. The LLM’s job: map your prompt to the right zmail queries and synthesize the result.

**Example user prompts:**

- **“Look at all my invoices and summarize all of my spending online.”**  
  Agent: search for invoices/receipts (e.g. from known senders or subject/body), fetch threads or attachments, extract amounts and categories, summarize.

- **“Summarize my meeting notes from last week’s Zoom with Larry.”**  
  Agent: search for Zoom emails (e.g. “Zoom” + “Larry” + last week), open the meeting summary/notes, summarize for the user.

- **“When is my flight to Cabo taking off? What’s my confirmation number?”**  
  Agent: search for Cabo/travel/booking emails, find the itinerary or confirmation, return departure time and confirmation number.

- **"RSVP yes to the dinner invite from Sarah."** *(future)*  
  Agent: find the invite, draft "Yes, I'll be there. Thanks!", confirm with user, send via zmail. No inbox. No compose. Just intent.

In each case: **user asks in plain language → LLM issues zmail search / zmail read (or thread) (and attachment) calls → LLM assembles the answer.** No inbox opening, no manual digging. Reliable and fast.

---

# Core Principles

1. **Agent-first**
   - Programmatic access is the primary interface.
   - Humans interact through tools built on top.

2. **Local-first / privacy-first**
   - Users control their own email data.
   - The system can run locally via Docker.

3. **Filesystem-native**
   - Email stored as files (Maildir style).
   - Agents can explore the mailbox like a repository.

4. **Fast indexed search**
   - Lexical search
   - Structured metadata queries
   - Optional semantic search

5. **Open standard**
   - Agent tools should rely on a standard interface.
   - The system could become the **standard email filesystem for AI agents**.

6. **Agent-intuitive interfaces**
   - We optimize for **discoverability** and **iterative learning**: commands and query syntax should match what agents naturally try (e.g. `zmail search "from:... term OR term"`, `zmail read <message_id>`).
   - When invocations fail, we output **token-efficient, corrective** help so the LLM can self-correct without a large generic help dump. The best CLI is the one the agent would instinctively use and can learn from iteratively — the agent analogue of a world-class human interface.

---

# Problem

Email systems today suffer from:

- Slow and limited search
- Poor programmatic access
- Siloed data stores
- UI-centric workflows
- No agent integration

Email is one of the **largest communication datasets in existence**, yet it remains largely inaccessible to automation.

---

# Solution

Build an **Agent-First Email System** that:

- Synchronizes mail from existing providers
- Stores mail locally
- Indexes it for fast retrieval
- Exposes a standard agent interface

This transforms email from:

```
Inbox UI
```

into:

```
Queryable communication dataset
```

---

# Deployment Model

Primary deployment:

**Self-hosted Docker container**

Benefits:

- Full privacy
- User owns their data
- Easy setup
- No central service reading user mail

The container becomes the user's:

```
Mail Brain
```

---

# Integration Modes

## 1. Clone / Copy Mode (Initial Model)

The system synchronizes email from existing providers.

Sources:

- Gmail
- Outlook
- Fastmail
- Any IMAP server

Advantages:

- User keeps existing address
- Zero deliverability issues
- Easy adoption
- Minimal disruption

This is the **recommended initial architecture**.

---

## 2. Replacement Mode (Future)

The system becomes the user's primary mail provider.

Requirements:

- SMTP ingress
- MX hosting
- Spam filtering
- Deliverability infrastructure

This provides maximum control but significantly increases operational complexity.

---

# Storage Model

Canonical storage should use **Maildir-style filesystem layout**.

Example:

```
Maildir/
   cur/
   new/
   tmp/
```

Each message is stored as a **raw RFC822 email file**.

Benefits:

- Simple
- Durable
- Easy backups
- Compatible with existing mail tooling

---

# Normalized Message Model

Raw email is preserved, but agents interact with normalized structures.

Example:

```
message_id
thread_id
timestamp
from
to
cc
subject
body_text
attachments
labels
provider_metadata
```

This prevents agents from needing to parse MIME.

---

# Indexing Layer

Filesystem storage alone is not sufficient for search.

A separate indexing system is required.

Pipeline:

```
raw MIME
   ↓
parse email
   ↓
extract text
   ↓
extract attachments
   ↓
normalize message
   ↓
index
```

Indexes may include:

- Lexical search
- Structured metadata
- Semantic embeddings

Possible technologies:

- Tantivy
- Postgres FTS
- Meilisearch
- pgvector

---

# Agent Interfaces

The system should expose multiple interfaces.

## CLI

Example commands:

```
zmail search "from:kirsten subject:contract"
zmail read <message_id>     # or zmail message <message_id>
zmail thread <thread_id>
```

Search query can use inline operators: `from:`, `to:`, `subject:`, `after:`, `before:`, and free text with `OR`/`AND` (e.g. `zmail search "from:alice@example.com invoice OR receipt"`).

## Tool Interface

Example functions:

```
search_mail(query)
get_thread(thread_id)
get_message(message_id)
```

## Filesystem Interface

Mailbox exposed as a virtual filesystem.

Example layout:

```
/mail
   /threads
      /thread-8473
         1.eml
         2.eml
   /attachments
   /contacts
```

This allows coding agents to explore mail like a code repository.

---

# Email as a Queryable Dataset

Traditional email treats messages as inbox items.

Agent-First Email treats email as a **structured dataset**.

Examples:

```
"find emails discussing pricing strategy"

"show threads where a decision was made"

"summarize customer complaints last quarter"
```

---

# The Full Loop: Inbox + Outbox

Today zmail is read-only — search, fetch, summarize. The end state is **read + write**: the agent is the complete interface. You never open your inbox. You never open a compose window.

**How it works:** zmail syncs mail (IMAP), indexes it, and exposes search + read to the agent. Add send (SMTP via the user's existing provider) and the loop closes: the agent can draft and send on your behalf. Notification → intent → draft → confirm → send. All through the agent.

**Killer differentiators** (beyond "agent can send"):

1. **Voice profile from history** — zmail has your full sent corpus. It can learn how you write: formal vs casual, length, sign-offs, greetings. And how that *varies by recipient* — first email to a new business contact vs a note to your spouse vs a question for your EA. Drafts sound like you, in the right register for the right person.

2. **Tagline as advertisement** — Every sent email carries a subtle footer: "Sent via zmail." Free distribution. Configurable.

3. **Intent-to-action** — OpenClaw + zmail already surfaces what matters. Add send: user says "rsvp yes" → agent finds the invite, drafts the reply, confirms, sends. No inbox. No compose. Just intent.

**Architecture:** SMTP (send-as-user through Gmail/Outlook/Fastmail) — same credentials, same identity, messages appear in Sent, zero deliverability risk. The provider stays the source of truth; zmail is the intelligence layer in front of it.

**Sequencing:** Send is blocked on customer validation for core search/index/onboarding. We want to nail that first.

---

# Long-Term Vision

Email becomes the foundation of a **communication graph**.

Additional data sources may include:

- Slack
- Google Docs
- Notion
- Jira
- Zoom transcripts
- Ticket systems

Eventually the system becomes:

```
AI-ready communication memory
```

Example query:

```
"show the emails, meetings, and documents that led to the pricing decision"
```

---

# Business Model (Open Source)

Core system:

**Open source**

Revenue opportunities:

### Hosted indexing service

Users sync their email to a hosted index and AI layer.

### Developer APIs

Agents and applications query communication data.

### Enterprise knowledge graph

Organizations build a company-wide communication intelligence layer.

---

# Working Name

**zmail**

```
Standard interface for agent-accessible communications
```

---

# Attachment Intelligence

Email attachments are a largely untapped part of the communication dataset.

Agent-First Email treats attachments as first-class queryable content:

- Attachments are extracted, converted to markdown, and indexed alongside message bodies
- Agents can list, read, and search attachment content in a single tool call
- No download-open-read loop — one query surfaces what's inside a PDF or contract

Example queries:

```
"what was in the contract they sent me last Friday"
"find any NDAs from vendors this year"
"summarize the budget spreadsheet from the Q3 planning thread"
```

Currently supported: PDF, DOCX, XLSX, HTML, CSV, plain text. Future: PPTX, images via vision model.

---

# Key Insight

The goal is not to build another email client.

The goal is to transform email from:

```
Inbox
```

into:

```
Communication dataset
```

for humans **and** AI agents.
