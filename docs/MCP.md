# MCP Server — Agent Interface

zmail exposes an MCP (Model Context Protocol) server for agent access to your email index. The server runs in **stdio-only mode** — no HTTP server, no port management, designed for local agent use.

## Overview

The MCP server provides programmatic access to zmail's search, message retrieval, and attachment extraction capabilities. It shares the same underlying SQLite index as the CLI, so all data synced via `zmail sync` or `zmail refresh` is immediately available through MCP tools.

## Architecture

- **Transport:** stdio (stdin/stdout) — no network, no ports, no auth required for local use
- **Protocol:** MCP (Model Context Protocol) via `@modelcontextprotocol/sdk`
- **Data source:** Same SQLite database (`~/.zmail/data/zmail.db`) as CLI commands
- **Index:** FTS5 (full-text) + LanceDB (semantic) hybrid search

## Starting the Server

```bash
zmail mcp
```

Or from the repo:
```bash
npm run zmail -- mcp
```

The server runs on stdio and communicates via JSON-RPC over stdin/stdout. It will run until terminated (Ctrl+C) or until stdin closes.

## Available Tools

### `search_mail`

Search emails using hybrid search (semantic + FTS5) by default. Returns matching messages with snippets. Use `fts=true` for FTS-only (exact keyword matching).

**Parameters:**
- `query` (string, optional): Full-text search query. Supports inline operators: `from:`, `to:`, `subject:`, `after:`, `before:`
- `limit` (number, optional): Maximum number of results (default: 20)
- `offset` (number, optional): Pagination offset (default: 0)
- `fromAddress` (string, optional): Filter by sender email address
- `afterDate` (string, optional): Filter messages after this date (ISO 8601 or relative like "7d", "30d")
- `beforeDate` (string, optional): Filter messages before this date
- `fts` (boolean, optional): If true, use FTS-only search (exact keyword matching). Default is false (hybrid search)

**Returns:** JSON array of message objects with `message_id`, `from`, `to`, `subject`, `date`, `snippet`, etc.

**Note:** CLI search results include attachment metadata (`attachments` count and `attachmentTypes` array). MCP `search_mail` currently returns basic message fields; use `list_attachments` tool to check for attachments.

**Example:**
```json
{
  "query": "invoice from:alice@example.com after:30d",
  "limit": 10
}
```

### `get_message`

Retrieve a single message by message ID. Returns message content in LLM-friendly format.

**Parameters:**
- `messageId` (string, required): Message ID (from `search_mail` results)
- `raw` (boolean, optional): Return raw EML format instead of parsed content (default: false)

**Returns:** Formatted message text (or raw EML if `raw: true`)

**Example:**
```json
{
  "messageId": "<abc123@example.com>",
  "raw": false
}
```

### `get_thread`

Retrieve a full conversation thread by thread ID. Returns all messages in the thread ordered by date.

**Parameters:**
- `threadId` (string, required): Thread ID (from `search_mail` or `get_message` results)
- `raw` (boolean, optional): Return raw EML format for each message instead of parsed/formatted content (default: false)

**Returns:** JSON array of message objects (same format as `get_message`)

**Example:**
```json
{
  "threadId": "<thread-123>",
  "raw": false
}
```

### `who`

Find people by email address or display name. Returns matching identities with sent/received/mentioned counts. Useful for "who is X?" queries.

**Parameters:**
- `query` (string, required): Search query to match against email addresses or display names
- `limit` (number, optional): Maximum number of results (default: 50)
- `minSent` (number, optional): Minimum sent count filter (default: 0)
- `minReceived` (number, optional): Minimum received count filter (default: 0)

**Returns:** JSON object with `query` and `people` array. Each person has `address`, `displayName`, `sentCount`, `receivedCount`, `mentionedCount`.

**Note:** When mailbox owner is configured, counts are relative to the owner: `sentCount` = emails I sent to them, `receivedCount` = emails from them to me, `mentionedCount` = emails where they were in to/cc but not the sender.

**Example:**
```json
{
  "query": "alice",
  "limit": 10
}
```

### `get_status`

Get sync and indexing status. Returns current state of sync (running/idle, last sync time, message count), indexing progress, search readiness (FTS/semantic counts), and date range of synced messages.

**Parameters:** None

**Returns:** JSON object with:
- `sync`: `{ isRunning, lastSyncAt, totalMessages, earliestSyncedDate, latestSyncedDate }`
- `indexing`: `{ isRunning, totalToIndex, indexedSoFar, startedAt, completedAt, totalIndexed, totalFailed, pending }`
- `search`: `{ ftsReady, semanticReady }`
- `dateRange`: `{ earliest, latest }` or `null`

**Example:**
```json
{}
```

### `get_stats`

Get database statistics. Returns total message count, date range, top senders (top 10), and messages by folder breakdown.

**Parameters:** None

**Returns:** JSON object with:
- `totalMessages`: number
- `dateRange`: `{ earliest, latest }` or `null`
- `topSenders`: array of `{ address, count }` (max 10)
- `folders`: array of `{ folder, count }`

**Example:**
```json
{}
```

### `list_attachments`

List all attachments for a message.

**Parameters:**
- `messageId` (string, required): Message ID to list attachments for

**Returns:** JSON array of attachment metadata objects with `id`, `filename`, `mimeType`, `size`, `extracted` (boolean)

**Example:**
```json
{
  "messageId": "<abc123@example.com>"
}
```

### `read_attachment`

Read and extract an attachment. Returns markdown (for documents) or CSV (for spreadsheets). Extraction happens on first call and is cached.

**Parameters:**
- `attachmentId` (number, required): Attachment ID (from `list_attachments` results)

**Returns:** Extracted text content (markdown for PDFs/DOCX, CSV for spreadsheets, plain text for TXT)

**Supported formats:** PDF, DOCX, XLSX, HTML, CSV, TXT

**Example:**
```json
{
  "attachmentId": 42
}
```

## Tool Workflow Examples

### Basic search and read workflow

1. **Search for messages:**
   ```json
   { "tool": "search_mail", "arguments": { "query": "contract", "limit": 5 } }
   ```

2. **Get full message:**
   ```json
   { "tool": "get_message", "arguments": { "messageId": "<msg-id-from-search>" } }
   ```

3. **Get full thread:**
   ```json
   { "tool": "get_thread", "arguments": { "threadId": "<thread-id-from-search>" } }
   ```

4. **List attachments:**
   ```json
   { "tool": "list_attachments", "arguments": { "messageId": "<msg-id>" } }
   ```

5. **Read attachment:**
   ```json
   { "tool": "read_attachment", "arguments": { "attachmentId": 7 } }
   ```

### People discovery workflow

1. **Find people:**
   ```json
   { "tool": "who", "arguments": { "query": "alice", "limit": 10 } }
   ```

2. **Search messages from a person:**
   ```json
   { "tool": "search_mail", "arguments": { "fromAddress": "alice@example.com" } }
   ```

### Status and statistics workflow

1. **Check sync/indexing status:**
   ```json
   { "tool": "get_status", "arguments": {} }
   ```

2. **Get database statistics:**
   ```json
   { "tool": "get_stats", "arguments": {} }
   ```

## Configuration

The MCP server uses the same configuration as the CLI:
- Config: `~/.zmail/config.json` (or `$ZMAIL_HOME/config.json`)
- Secrets: `~/.zmail/.env` (or `$ZMAIL_HOME/.env`)

No additional MCP-specific configuration is required. The server reads the database path from the config and connects to the same SQLite database used by CLI commands.

## Differences from CLI

| Aspect | CLI | MCP |
|--------|-----|-----|
| **Interface** | Command-line subprocess | JSON-RPC over stdio |
| **Use case** | Direct agent shell execution | Programmatic agent integration |
| **Output** | Human-readable + JSON flag | Structured JSON only |
| **Transport** | Process invocation | Persistent stdio connection |

Both interfaces share the same underlying index and data. A message synced via `zmail sync` is immediately available via MCP `search_mail`, and vice versa.

## Future Work

- Resources: Expose message/thread data as MCP resources
- Prompts: Pre-built prompt templates for common email queries

## See Also

- [ARCHITECTURE.md](./ARCHITECTURE.md) — ADR-005: Dual Agent Interface
- [AGENTS.md](../AGENTS.md) — Development guide and CLI reference
- [STRATEGY.md](./STRATEGY.md) — Strategic priorities including MCP tool surface
