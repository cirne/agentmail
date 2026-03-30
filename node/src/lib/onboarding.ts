/**
 * Canonical onboarding and CLI usage text. No dependencies — safe to import
 * before config. Reuse in CLI, MCP tools, docs, etc.
 */

/** One-line hint shown when a command fails due to missing config. */
export const ONBOARDING_HINT_MISSING_ENV =
  "Run 'zmail setup' to configure zmail.";

/** Body of `zmail --version` after the semver line (matches Rust `CLI_LONG_VERSION`). */
export function formatNodeCliLongVersion(version: string): string {
  return `${version}\n\n${CLI_VERSION_LONG_BODY}`;
}

const CLI_VERSION_LONG_BODY = `Upgrade / reinstall (prebuilt binary):
  curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | INSTALL_PREFIX=~/bin bash
  curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | bash -s -- --nightly

If you installed via Homebrew, npm, or cargo, upgrade with that tool instead.
`;

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

${CLI_VERSION_LONG_BODY.trimEnd()}

Run zmail <command> --help for command-specific options.
`;
