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
  zmail search <query> [flags]    Search email (FTS5 full-text search)
  zmail who <query> [flags]       Find people by address or name (use --help for flags)
  zmail status [--imap]           Show sync and indexing status (--imap for IMAP server comparison, may take 10+ seconds)
  zmail stats                     Show database statistics
  zmail thread <id> [--json]      Fetch thread (text by default; --json for structured output)
  zmail read <id> [--raw]         Read a message (or: zmail message <id>)
  zmail attachment list <message_id>   List attachments (use message_id from search)
  zmail attachment read <message_id> <index>|<filename>   Read by index (1-based) or filename
  zmail mcp                       Start MCP server (stdio)

Agent interfaces:
  CLI (this): Use for direct subprocess calls. Fast for one-off queries. Commands default to JSON (search, who, attachment list) or text (read, thread, status, stats). Use --text or --json flags to override.
  MCP: Use for persistent tool-based integration. Run 'zmail mcp' to start stdio server. See docs/MCP.md.
`;
