/**
 * Reference CLI usage text for the npm/Node path (parity / port). Primary UX is
 * the Rust binary — install/upgrade one-liners: run `zmail --version` on the
 * Rust build, or see `src/cli/root_help.txt` / `install.sh` in-repo.
 */

/** One-line hint shown when a command fails due to missing config. */
export const ONBOARDING_HINT_MISSING_ENV =
  "Run 'zmail setup' to configure zmail.";

export const CLI_USAGE = `zmail — agent-first email

Usage:
  zmail                      Show this help

Setup & sync
  zmail setup [--email <e>] [--password <p>] [--openai-key <k>] [--no-validate]
  zmail wizard [--no-validate]
  zmail sync [--since <spec>] [--foreground]
  zmail refresh
  zmail status [--imap]
  zmail stats
  zmail rebuild-index

Search & read
  zmail search <query> [flags]
  zmail who [query] [flags]
  zmail read <id> [--raw]
  zmail thread <id> [--json]
  zmail attachment list <message_id>
  zmail attachment read <message_id> <index>|<filename>

Assistants
  zmail ask "<question>" [--verbose]
  zmail inbox [<window>] [--since ...] [--refresh] [--text]

Send & integration
  zmail send [flags] [<draft-id>]
  zmail draft <subcommand> [args]
  zmail mcp

Run zmail <command> --help for command-specific options.
`;
