# MCP Server — Agent Interface

zmail exposes an MCP (Model Context Protocol) server for agent access to your email index. The server runs in **stdio-only mode** — no HTTP server, no port management, designed for local agent use.

## Overview

The MCP server provides programmatic access to zmail's search, message retrieval, and attachment extraction capabilities. It shares the same underlying SQLite index as the CLI, so all data synced via `zmail sync` or `zmail refresh` is immediately available through MCP tools.

## Architecture

- **Transport:** stdio (stdin/stdout) — no network, no ports, no auth required for local use
- **Protocol:** MCP (Model Context Protocol) via `@modelcontextprotocol/sdk`
- **Data source:** Same SQLite database (`~/.zmail/data/zmail.db`) as CLI commands
- **Index:** FTS5 full-text search

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

Search emails using FTS5 full-text search. The tool **always** returns a JSON **object** (not a bare array):

- `results` — array of hits (shape depends on `format`)
- `returned` — number of objects in `results`
- `totalMatched` — total hits before any limit
- `format` — `"slim"` or `"full"`
- `hint` — present when `format` is `slim`; explains how to fetch full rows via `get_messages`
- `threads` — optional, when `includeThreads: true`
- `timings` — optional search timings

**Slim vs full:** With `resultFormat: "auto"` (default), if there are **more than 50** results, each element of `results` is **slim**: `messageId`, `subject`, `fromName` (if present), `date`, `attachments` (integer count when greater than zero), `attachmentTypes` (deduplicated MIME subtype strings, e.g. `pdf`, when count > 0). Otherwise each element is **full**: `messageId`, `threadId`, `fromAddress`, `fromName`, `subject`, `date`, `snippet`, `bodyPreview`, `attachments` (array of `{ id, filename, mimeType, size, extracted, index }` when present — same 1-based `index` as `read_attachment`). Use `resultFormat: "full"` to force full rows for large result sets, or `resultFormat: "slim"` to force slim rows for small sets.

**Parameters:**
- `query` (string, optional): Full-text search query. Supports inline operators: `from:`, `to:`, `subject:`, `after:`, `before:`
- `limit` (number, optional): Maximum number of results (default: all matches)
- `offset` (number, optional): Pagination offset (default: 0)
- `fromAddress` (string, optional): Filter by sender email address
- `afterDate` (string, optional): Filter messages after this date (ISO 8601 or relative like "7d", "30d")
- `beforeDate` (string, optional): Filter messages before this date
- `includeThreads` (boolean, optional): When true, also return full threads (all messages per matching thread) as a `threads` array (default: false)
- `includeNoise` (boolean, optional): When true, includes noise messages (promotional, social, forums, bulk, spam) in results (Gmail categories: Promotions, Social, Forums, Spam). Defaults to false — noise messages are excluded by default.
- `resultFormat` (string, optional): `"auto"` | `"full"` | `"slim"` — controls per-result shape (default: `auto`; see above).

**Note:** CLI JSON search uses the same slim threshold and adds `--result-format`. Full rows inline the same attachment fields as `list_attachments` except `stored_path`. Use `list_attachments` when you need `stored_path` or are not coming from search.

**Example:**
```json
{
  "query": "invoice from:alice@example.com after:30d",
  "limit": 10
}
```

### `get_message`

Retrieve a single message by message ID. **Returns the same JSON shape as one element of `get_messages`** — same parameters (`detail`, `maxBodyChars`) and same body/truncation logic. Use for one-off reads; use `get_messages` to batch-read multiple. Message IDs can be passed with or without angle brackets; the server normalizes them.

**Parameters:**
- `messageId` (string, required): Message ID (from `search_mail` results)
- `raw` (boolean, optional): If true, return raw EML (same as `detail: "raw"`). Prefer `detail`.
- `detail` (string, optional): `"full"` = lean message with body up to maxBodyChars (default); `"summary"` = minimal + 200-char snippet; `"raw"` = EML. Same as `get_messages`.
- `maxBodyChars` (number, optional): When `detail` is `"full"`, max body chars (default: 2000). Same as `get_messages`. Ignored for `summary` or `raw`.

**Returns:** Single JSON object (same shape as `get_messages(..., detail)[0]`), or raw EML when `raw: true` / `detail: "raw"`. Empty arrays and null/empty fields are omitted to save tokens.

**Example (full, default):**
```json
{
  "messageId": "<abc123@example.com>"
}
```

**Example (summary or custom body cap):**
```json
{
  "messageId": "<abc123@example.com>",
  "detail": "summary"
}
```
```json
{
  "messageId": "<abc123@example.com>",
  "detail": "full",
  "maxBodyChars": 4000
}
```

### `get_messages`

Retrieve multiple messages by message IDs. Use **detail** to control payload size: `full` = lean message with body up to maxBodyChars; `summary` = minimal fields + 200-char snippet for scanning; `raw` = original EML. Caps at 20 messages per call. Empty arrays and null/empty fields are omitted to save tokens.

**Auto summary:** If **`detail` is omitted** and **`messageIds` contains more than 5 IDs** (after the 20-ID cap), every message is returned in **summary** form (same as `detail: "summary"`) to limit token use. Pass **`detail: "full"`** explicitly to force full bodies for large batches.

**Parameters:**
- `messageIds` (array of strings, required): Array of message IDs (from `search_mail` results) to retrieve
- `detail` (string, optional): `"full"` = full lean message with body; `"summary"` = minimal fields + 200-char snippet; `"raw"` = original EML format. Omit to let the server choose: batches of 6+ IDs default to summary unless you pass `"full"`.
- `raw` (boolean, optional): If true, same as `detail: "raw"`. Prefer `detail`.
- `maxBodyChars` (number, optional): Max characters of body per message when the effective detail is `"full"` (default: 2000). Ignored for `summary` or `raw`.

**Response by detail level:**

- **`detail: "summary"`** — Tiny payload for scanning (e.g. 20 messages in one call). Each message: `message_id`, `subject`, `from` (combined string), `to` (array, omitted if empty), `date`, `snippet` (first 200 chars of body).
- **`detail: "full"`** (default) — Lean message: `message_id`, `thread_id`, `from_address`, `from_name` (if present), `to_addresses`, `cc_addresses`, `subject`, `date`, `content: { markdown }`, `bodyTruncated` (only when true), `attachments`, `labels`. Empty arrays and null/empty fields omitted.
- **`detail: "raw"`** — Full EML format per message.

**Example (full):**
```json
{
  "messageIds": ["<abc123@example.com>", "<def456@example.com>"],
  "maxBodyChars": 500
}
```

**Example (summary — for scanning):**
```json
{
  "messageIds": ["<id1>", "<id2>", "<id3>", "<id4>", "<id5>"],
  "detail": "summary"
}
```

**Token efficiency (agents):** Prefer `detail: "summary"` when scanning 5+ messages; use `detail: "full"` with `maxBodyChars: 500` for quick confirmation or `maxBodyChars: 4000` for full reads.

### `get_thread`

Retrieve a full conversation thread by thread ID. Returns all messages in the thread ordered by date. When `raw` is false (default), returns the same **lean** shape as `get_messages` (detail: "full"): no noise fields, body head-truncated at 2000 chars, empty fields omitted. Thread IDs can be passed with or without angle brackets; the server normalizes them.

**Parameters:**
- `threadId` (string, required): Thread ID (from `search_mail` or `get_message` results) to retrieve
- `raw` (boolean, optional): If true, return raw EML format for each message instead of parsed/formatted content (default: false)

**Returns:** JSON array of message objects (lean shape when raw=false; same as get_messages detail: "full" with 2000-char body cap)

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
- `includeNoreply` (boolean, optional): Include noreply/bot addresses (default: false)
- `enrich` (boolean, optional): Use LLM (GPT-4.1 nano) to guess names from email addresses for better accuracy. Requires `ZMAIL_OPENAI_API_KEY` to be set. Adds ~1-2s latency (default: false)

**Returns:** JSON object with `query` and `people` array. Each person has `firstname`, `lastname`, `name`, `primaryAddress`, `addresses`, `phone`, `title`, `company`, `urls`, `sentCount`, `receivedCount`, `mentionedCount`, `lastContact`. May include `hint` field with suggestions (e.g., to use `enrich` flag).

**Note:** When mailbox owner is configured, counts are relative to the owner: `sentCount` = emails I sent to them, `receivedCount` = emails from them to me, `mentionedCount` = emails where they were in to/cc but not the sender.

**Example:**
```json
{
  "query": "alice",
  "limit": 10,
  "enrich": true
}
```

### `get_status`

Get sync and indexing status. Returns current state of sync (running/idle, last sync time, message count), indexing progress, search readiness (FTS count), date range of synced messages, and freshness (time since latest mail and last sync).

**Parameters:** None

**Returns:** JSON object with:
- `sync`: `{ isRunning, lastSyncAt, totalMessages, earliestSyncedDate, latestSyncedDate }`
- `indexing`: `{ isRunning, totalToIndex, indexedSoFar, startedAt, completedAt, totalIndexed, totalFailed, pending }`
- `search`: `{ ftsReady }`
- `dateRange`: `{ earliest, latest }` or `null`
- `freshness`: `{ latestMailAgo, lastSyncAgo }` — each value is `null` or `{ human: string, duration: string }` (e.g. `{ human: "2 hours ago", duration: "PT2H" }`); `null` when not applicable

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

List all attachments for a message. Message IDs can be passed with or without angle brackets; the server normalizes them.

**Parameters:**
- `messageId` (string, required): Message ID (from `search_mail` or `get_message`) to list attachments for

**Returns:** JSON array of attachment metadata objects with `id`, `filename`, `mimeType`, `size`, `extracted` (boolean). Use `id` with `read_attachment`.

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

### CLI arguments (quick reference)

- **search:** `zmail search <query> [--limit n] [--detail headers|snippet|body] [--fields csv] [--threads] [--ids-only] [--timings] [--text] [--from addr] [--after date] [--before date] [--include-noise]`
- **who:** `zmail who <query> [--limit n] [--min-sent n] [--min-received n] [--all] [--enrich] [--text]`
- **status:** `zmail status [--json] [--imap]` — `--imap` compares local DB with IMAP server (CLI-only).
- **stats:** `zmail stats [--json]`
- **read:** `zmail read <message_id> [--raw]` (alias: `zmail message`)
- **thread:** `zmail thread <thread_id> [--json] [--raw]`
- **attachment list:** `zmail attachment list <message_id> [--text]`
- **attachment read:** `zmail attachment read <message_id> <index>|<filename> [--raw] [--no-cache]` — CLI uses message_id + 1-based index or filename; MCP uses numeric attachment `id` from `list_attachments`.

## Future Work

- Resources: Expose message/thread data as MCP resources
- Prompts: Pre-built prompt templates for common email queries

## Higher-Level Query Interface: `zmail ask`

For agents that want natural language answers instead of orchestrating primitive tools, zmail provides `zmail ask "<question>"` — a single-call answer engine that handles all orchestration internally. See [ASK.md](./ASK.md) for when to use `ask` vs primitive tools, integration patterns, and performance characteristics.

## See Also

- [ASK.md](./ASK.md) — Using `zmail ask` as a higher-level query interface
- [ARCHITECTURE.md](./ARCHITECTURE.md) — ADR-005: Dual Agent Interface
- [AGENTS.md](../AGENTS.md) — Development guide and CLI reference
- [STRATEGY.md](./STRATEGY.md) — Strategic priorities including MCP tool surface
