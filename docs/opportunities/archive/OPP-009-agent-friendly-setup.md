# OPP-009: Agent-Friendly Non-Interactive Setup + Human-Friendly Wizard

**Problem:** The current `zmail setup` flow requires an interactive TTY and synchronous human interaction via readline prompts. This doesn't work for stdio-based agent interactions (like Claude Code, Cursor, or other AI assistants) where stdin isn't a TTY and the agent needs to provide credentials programmatically.

When an agent tries to set up zmail, it hits a wall: `zmail setup` detects non-interactive mode and exits with instructions to manually create config files, which defeats the purpose of agent automation.

Additionally, the current readline-based prompts feel dated compared to modern CLI tools that use rich TUI experiences (like OpenClaw's wizard, Claude Code's `/config` interface).

**Example:** An agent wants to set up zmail for a user. It has:
- Email address: `user@gmail.com`
- Gmail app password: `abcd efgh ijkl mnop`
- OpenAI API key: `sk-...`

Currently, the agent must manually create `~/.zmail/config.json` and `~/.zmail/.env` files, which is error-prone and doesn't leverage the validation logic built into `zmail setup`.

**Proposed direction:** Split setup into two distinct workflows:
1. **`zmail setup`** — Non-interactive, agent-friendly setup via CLI flags/env vars (like AWS CLI, GitHub CLI)
2. **`zmail wizard`** — Interactive, human-friendly TUI wizard (like OpenClaw's `openclaw setup --wizard`)

## Requirements

The three mandatory items for setup:
1. **Email address** (Gmail only for now to simplify)
2. **IMAP app password** (Gmail app password)
3. **OpenAI API key** (for semantic search)

## Implementation approach

### `zmail setup` — Non-interactive, agent-friendly

**Design:** When all required values are provided via CLI flags or environment variables, `zmail setup` runs non-interactively without prompts. This follows patterns from AWS CLI, GitHub CLI, and other agent-friendly tools.

**CLI flags (preferred for explicit agent control):**
```bash
zmail setup --email user@gmail.com --password "abcd efgh ijkl mnop" --openai-key "sk-..."
```

**Environment variables (fallback for CI/automation):**
```bash
ZMAIL_EMAIL=user@gmail.com ZMAIL_IMAP_PASSWORD="..." ZMAIL_OPENAI_API_KEY="sk-..." zmail setup
```

**Behavior:**
- If all required values provided (flags or env vars), skip prompts and proceed directly to validation/write
- If values missing, exit with clear error message (don't prompt — agents can't respond)
- Flags take precedence over environment variables
- Support `--no-validate` to skip credential validation

### `zmail wizard` — Interactive, human-friendly TUI

**Design:** A rich terminal UI wizard following patterns from OpenClaw (`openclaw setup --wizard`) and modern CLI tools. Provides a guided, step-by-step experience with visual feedback.

**Features:**
- Clean, modern TUI using a library like `ink` (React for CLI), `blessed`, or `inquirer` with custom styling
- Step-by-step flow with progress indicators
- Real-time validation feedback (e.g., "✓ Connected to Gmail" with green checkmark)
- Helpful hints and links (e.g., "Create app password at https://myaccount.google.com/apppasswords")
- Optional QuickStart mode (preset defaults) vs Advanced mode (full control)
- Can reuse validation logic from `setup.ts`

**Example flow:**
```
┌─────────────────────────────────────────┐
│  zmail Setup Wizard                      │
├─────────────────────────────────────────┤
│  Step 1/3: Email Configuration         │
│                                          │
│  Email address: [user@gmail.com      ]  │
│  → Gmail detected (imap.gmail.com:993)  │
│                                          │
│  [Next] [Skip] [Cancel]                  │
└─────────────────────────────────────────┘
```

**Why separate commands?**
- Clear separation of concerns: `setup` = programmatic, `wizard` = interactive
- Familiar pattern: OpenClaw uses `setup --wizard`, many tools have `wizard` subcommands
- Better UX: Humans get rich TUI, agents get simple flags
- Easier to maintain: No complex conditional logic mixing interactive/non-interactive flows

## Implementation details

### Phase 1: Non-interactive `zmail setup`

1. **Update `src/lib/config.ts`** — Support `ZMAIL_EMAIL` environment variable (replaces old `IMAP_USER` naming)

2. **Refactor `src/cli/setup.ts`** — Split into:
   - `runSetup()` — Non-interactive setup function that accepts options and never prompts
   - Extract validation logic into shared functions
   - Remove all readline/prompt code from `runSetup()`

3. **Update `src/index.ts`** — Parse CLI flags for setup command:
   - `--email <value>` → email
   - `--password <value>` → password  
   - `--openai-key <value>` → OpenAI API key
   - Pass parsed values to `runSetup()`
   - If values missing, exit with clear error (don't prompt)

4. **Security considerations:**
   - Never echo passwords/secrets to stdout
   - Support `--no-validate` flag to skip credential validation
   - Environment variables are safer than CLI args for secrets (CLI args visible in `ps` output), but flags are more explicit for agent control

### Phase 2: Interactive `zmail wizard`

1. **Create `src/cli/wizard.ts`** — New wizard implementation:
   - Use TUI library (recommend `ink` for React-like components, or `inquirer` for simpler prompts)
   - Step-by-step flow: email → password → OpenAI key → sync settings
   - Real-time validation with visual feedback
   - Call shared validation functions from `setup.ts`

2. **Add `wizard` command to `src/index.ts`**:
   - Route `zmail wizard` to new wizard implementation
   - Can also support `zmail setup --wizard` as alias for familiarity

3. **TUI library options:**
   - **`ink`** (React for CLI) — Most flexible, modern, great for complex UIs
   - **`inquirer`** — Simpler, widely used, good for basic forms
   - **`blessed`** — Lower-level, more control but more complex

**Recommendation:** Start with `inquirer` for simplicity, upgrade to `ink` if we need richer UI later.

## Example workflows

### Agent workflow (non-interactive)

```bash
# Agent can now do:
zmail setup --email user@gmail.com --password "$GMAIL_APP_PASSWORD" --openai-key "$OPENAI_API_KEY" --no-validate

# Or via environment variables:
export ZMAIL_EMAIL=user@gmail.com
export ZMAIL_IMAP_PASSWORD="..."
export ZMAIL_OPENAI_API_KEY="sk-..."
zmail setup --no-validate
```

### Human workflow (interactive)

```bash
# Rich TUI wizard experience:
zmail wizard

# Or alias (if we support it):
zmail setup --wizard
```

## What stays the same

- Existing config file structure (`~/.zmail/config.json` and `~/.zmail/.env`)
- Validation logic (IMAP connection test, OpenAI API test) — shared between `setup` and `wizard`
- Gmail auto-detection from email domain
- All other zmail commands and functionality

## Open questions

- **TUI library choice:** Start with `inquirer` (simpler) or `ink` (more flexible)? Recommendation: `inquirer` for MVP, upgrade later if needed.
- **Wizard features:** Should wizard support QuickStart mode (preset defaults) vs Advanced mode (full control), like OpenClaw?
- **Password input:** Should wizard support reading password from stdin or a file for extra security? (e.g., `--password-file` or `--password-stdin`)
- **Email provider:** Should `--email` flag accept non-Gmail addresses and prompt for IMAP host/port, or keep Gmail-only for now?
- **Sync duration:** Should we add a `--default-since` flag for sync duration, or keep defaulting to "1y"?
- **Backward compatibility:** Should `zmail setup` without flags still work interactively (calling wizard), or exit with error directing users to `zmail wizard`?

## References

- [OpenClaw setup wizard](https://docs.openclaw.ai/start/wizard) — Example of modern CLI wizard pattern
- [OpenClaw config command](https://docs.openclaw.ai/cli/config) — Dot notation for nested config
- [Claude Code settings](https://code.claude.com/docs/en/settings) — Scope-based config hierarchy
- [Inquirer.js](https://github.com/SBoudrias/Inquirer.js) — Popular TUI library for Node.js
- [Ink](https://github.com/vadimdemedes/ink) — React for CLI, more flexible than Inquirer

## See also

- [AGENTS.md](../../AGENTS.md) — current setup documentation
- [OPP-005](archive/OPP-005-onboarding-claude-code.md) — previous onboarding improvements (archived)
- [src/cli/setup.ts](../../src/cli/setup.ts) — current setup implementation
