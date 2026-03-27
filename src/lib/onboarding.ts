/**
 * Canonical onboarding and CLI usage text. No dependencies — safe to import
 * before config. Reuse in CLI, MCP tools, docs, etc.
 */

/** One-line hint shown when a command fails due to missing config. */
export const ONBOARDING_HINT_MISSING_ENV =
  "Run 'zmail setup' to configure zmail.";

export const CLI_USAGE = `zmail — agent-first email

Usage:
  zmail                      Show quick help and common commands
  zmail setup [--email <e>] [--password <p>] [--openai-key <k>] [--no-validate]   Setup via flags/env
  zmail wizard [--no-validate]   Interactive setup (prompts for credentials)
  zmail sync [--since <spec>] [--foreground]     Initial sync: fill gaps going backward (runs in background by default; use --foreground to wait)
  zmail refresh                    Refresh: fetch new messages since last sync (frequent updates)
  zmail inbox [<window>] [--since ...] [--refresh] [--text]   LLM scan of a time window; JSON envelope matches refresh (needs OpenAI key)
  zmail rebuild-index              Wipe SQLite and reindex from local maildir (same as schema bump; dev/test)
  zmail ask "<question>" [--verbose]   Answer a natural-language question (zmail orchestrates search/read; needs OpenAI key: ZMAIL_OPENAI_API_KEY or OPENAI_API_KEY)
  zmail search <query> [flags]    Search email (FTS5 full-text search)
  zmail who [query] [flags]       Find people by address or name; omit query for top contacts (see --help)
  zmail status [--imap]           Show sync and indexing status (--imap for IMAP server comparison, may take 10+ seconds)
  zmail stats                     Show database statistics
  zmail thread <id> [--json]      Fetch thread (text by default; --json for structured output)
  zmail read <id> [--raw]         Read a message (or: zmail message <id>)
  zmail attachment list <message_id>   List attachments (use message_id from search)
  zmail attachment read <message_id> <index>|<filename>   Read by index (1-based) or filename
  zmail send [--to ... --subject ...] [--raw] [<draft-id>] [--dry-run]   SMTP send-as-user; <draft-id> sends saved draft (archives to data/sent/). Dev: only lewiscirne+zmail@gmail.com unless ZMAIL_SEND_PRODUCTION=1
  zmail draft …                 Compose locally; see zmail draft --help (new|reply|forward|list|view|edit|rewrite; edit = LLM revises from your words; rewrite = replace body; --text for human-readable output)
  zmail mcp                       Start MCP server (stdio)

Draft + send (core loop): zmail draft reply … (or new/forward) → zmail draft edit <id> "…" to refine with the LLM → zmail send <id> --dry-run then zmail send <id>. Same pipeline via MCP: create_draft, send_draft.

Ask vs search / read / thread / who / attachment / inbox:
  ask — Use for one-shot natural-language questions and let zmail retrieve and summarize (fast path for agents; requires ZMAIL_OPENAI_API_KEY or OPENAI_API_KEY).
  inbox — Fast metadata+LLM pass over recent mail; same JSON shape as refresh for agents (notable messages in newMail; requires OpenAI key).
  search, read, thread, who, attachment — Use for structured JSON, exact filters or IDs, scripts, UI drill-down, raw/EML, or debugging. No API key for core use (optional: e.g. who --enrich).
  Full tradeoffs and hybrid patterns: docs/ASK.md

Agent interfaces:
  CLI (this): Subprocess-friendly. Defaults: JSON for search, who, attachment list; text for read, thread, status, stats. Use --text or --json to override.
  MCP: Run 'zmail mcp' (stdio). Same index as CLI. Tools and token-efficient patterns (e.g. includeThreads, batch get_messages): docs/MCP.md
`;
