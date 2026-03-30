/**
 * Canonical onboarding and CLI usage text. No dependencies — safe to import
 * before config. Reuse in CLI, MCP tools, docs, etc.
 */

/** One-line hint shown when a command fails due to missing config. */
export const ONBOARDING_HINT_MISSING_ENV =
  "Run 'zmail setup' to configure zmail.";

export const CLI_USAGE = `zmail — agent-first email

Usage:
  zmail                      Show this help
  zmail setup [--email <e>] [--password <p>] [--openai-key <k>] [--no-validate]
  zmail wizard [--no-validate]
  zmail sync [--since <spec>] [--foreground]
  zmail refresh
  zmail inbox [<window>] [--since ...] [--refresh] [--text]
  zmail rebuild-index
  zmail ask "<question>" [--verbose]
  zmail search <query> [flags]
  zmail who [query] [flags]
  zmail status [--imap]
  zmail stats
  zmail thread <id> [--json]
  zmail read <id> [--raw]
  zmail attachment list <message_id>
  zmail attachment read <message_id> <index>|<filename>
  zmail send [flags] [<draft-id>]
  zmail draft <subcommand> [args]
  zmail mcp

Run zmail <command> --help for command-specific options.
`;
