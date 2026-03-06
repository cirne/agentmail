# zmail

Email as a queryable dataset for AI agents.

Modern email systems are human-first — designed around inbox browsing and manual workflows. **zmail** reimagines email as a structured, searchable dataset with a native interface for AI agents.

## What it does

- Syncs email from IMAP (Gmail-first) into local storage (`~/.zmail/data/maildir`, `~/.zmail/data/zmail.db`, `~/.zmail/data/vectors`)
- Indexes for FTS + semantic retrieval and exposes CLI + MCP interfaces
- Supports agent-optimized shortlist → hydrate workflows via CLI search controls

## Quick start

1. **Install**
   ```bash
   curl -fsSL https://raw.githubusercontent.com/cirne/zmail/main/install.sh | bash
   ```
   
   Or for development:
   ```bash
   npm install
   ```

2. **Run interactive setup**
   ```bash
   bun run src/index.ts setup
   ```
   This creates `~/.zmail/config.json` and `~/.zmail/.env` with your IMAP credentials and OpenAI API key. The setup command validates credentials and guides you through the process.

3. **Initial sync (example: last 7 days)**
   ```bash
   bun run src/index.ts sync --since 7d
   ```
   
   **Refresh (fetch new messages):**
   ```bash
   bun run src/index.ts refresh
   ```

4. **Search (header-first default)**
   ```bash
   bun run src/index.ts search "apple receipt after:30d" --json
   ```

## CLI

```bash
zmail sync [--since <spec>]     # Initial sync: fill gaps going backward
zmail refresh                    # Refresh: fetch new messages since last sync
zmail search <query> [--mode auto|fts|semantic|hybrid]
                  [--detail headers|snippet|body]
                  [--fields <csv>] [--ids-only] [--timings]
                  [--limit <n>] [--json]
zmail status
zmail stats
zmail read <id> [--raw]         # or zmail message <id>
zmail thread <id> [--raw]
zmail mcp
```

Query can use inline operators: `from:`, `to:`, `subject:`, `after:`, `before:` (e.g. `zmail search "from:alice@example.com invoice OR receipt"`).

### Recommended agent retrieval pattern

```bash
# 1) Fast shortlist
zmail search "from:no_reply@email.apple.com receipt after:30d" \
  --detail headers --fields messageId,date,subject --ids-only --json

# 2) Hydrate selected IDs
zmail read "<message-id>"

# Optional: fetch original raw MIME source
zmail read "<message-id>" --raw
```

### Schema drift recovery

zmail intentionally does not run automatic migrations on existing local DBs. If startup reports schema drift, rebuild local data and resync:

```bash
rm -rf ~/.zmail/data/
bun run src/index.ts sync --since 7d
```

## Architecture

Built with TypeScript + Bun. All data stored locally on a persistent volume — no cloud sync service, no third-party access to your email. Storage layout and technical decisions: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Product vision: [`docs/VISION.md`](docs/VISION.md).

## Status

Active development. Core sync/index/search flows are working; CLI search interface is being expanded for agent-first workflows.

## License

MIT
