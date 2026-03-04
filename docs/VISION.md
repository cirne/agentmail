# Agent-First Email
## Vision

> Architectural decisions and the technical design log live in [ARCHITECTURE.md](./ARCHITECTURE.md).

### Summary

Modern email systems (Gmail, Outlook, etc.) are **human-first interfaces** designed around inbox browsing and manual workflows.

They are poorly suited for the emerging world of **AI agents and programmatic interaction**.

Agent-First Email reimagines email as a **queryable dataset and filesystem-like repository of communication artifacts**, where the primary interface is **tools and APIs for agents**, and the human UI is optional.

Instead of browsing inboxes, agents **query communication graphs**.

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
mail search "from:kirsten subject:contract"
mail thread <thread_id>
mail attachments --type=pdf
```

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

Internal name:

**Agent Mail Interface (AMI)**

Potential goal:

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

Supported formats: PDF, DOCX, XLSX, PPTX, HTML, CSV, plain text. Images described via vision model.

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
