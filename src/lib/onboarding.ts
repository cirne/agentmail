/**
 * Canonical onboarding and CLI usage text. No dependencies — safe to import
 * before config. Reuse in CLI, MCP tools, docs, etc.
 */

/** One-line hint shown when a command fails due to missing config. */
export const ONBOARDING_HINT_MISSING_ENV =
  "Run 'zmail setup' to configure zmail.";

export const CLI_USAGE = `zmail — agent-first email

Usage:
  zmail                      Start background sync
  zmail setup                Interactive setup (creates ~/.zmail/config.json and .env)
  zmail sync [--since <spec>]     Initial sync: fill gaps going backward (e.g. --since 7d, 5w, 3m, 2y)
  zmail refresh                    Refresh: fetch new messages since last sync (frequent updates)
  zmail search <query> [flags]    Search email (use --help for flags)
  zmail who <query> [flags]       Find people by address or name (use --help for flags)
  zmail status                    Show sync and indexing status
  zmail stats                     Show database statistics
  zmail thread <id> [--raw]       Fetch thread (Markdown by default; raw .eml with --raw)
  zmail read <id> [--raw]         Read a message (or: zmail message <id>)
  zmail mcp                       Start MCP server (stdio)

Agent interfaces:
  CLI (this): Use for direct subprocess calls. Fast for one-off queries, returns JSON with --json flag.
  MCP: Use for persistent tool-based integration. Run 'zmail mcp' to start stdio server. See docs/MCP.md.
`;
