# zmail

Email as a queryable dataset for AI agents.

Modern email systems are human-first — designed around inbox browsing and manual workflows. **zmail** reimagines email as a structured, searchable dataset with a native interface for AI agents.

## What it does

- Syncs email from IMAP (Gmail-first) into local storage (`data/maildir`, `data/zmail.db`, `data/vectors`)
- Indexes for FTS + semantic retrieval and exposes CLI + MCP interfaces
- Supports agent-optimized shortlist → hydrate workflows via CLI search controls

## Quick start

1. **Install + env**
   ```bash
   bun install
   cp .env.example .env
   ```

2. **Set required credentials in `.env`**
   ```bash
   IMAP_USER=your@gmail.com
   IMAP_PASSWORD=xxxx-xxxx-xxxx-xxxx
   OPENAI_API_KEY=sk-...
   ```
   Use a [Gmail app password](https://support.google.com/accounts/answer/185833) for `IMAP_PASSWORD`.

3. **Sync + index (example: last 7 days)**
   ```bash
   bun run src/index.ts sync --since 7d
   ```

4. **Search (header-first default)**
   ```bash
   bun run src/index.ts search "apple receipt" --after 30d --json
   ```

## CLI

```bash
zmail sync [--since <spec>]
zmail search <query> [--from <address>] [--after <date>] [--before <date>]
                  [--mode auto|fts|semantic|hybrid]
                  [--detail headers|snippet|body]
                  [--fields <csv>] [--ids-only] [--timings]
                  [--limit <n>] [--json]
zmail status
zmail stats
zmail thread <id>
zmail message <id>
zmail mcp
```

### Recommended agent retrieval pattern

```bash
# 1) Fast shortlist
zmail search "receipt" --from no_reply@email.apple.com --after 30d \
  --detail headers --fields messageId,date,subject --ids-only --json

# 2) Hydrate selected IDs
zmail message "<message-id>"
```

### Schema drift recovery

zmail intentionally does not run automatic migrations on existing local DBs. If startup reports schema drift, rebuild local data and resync:

```bash
rm -rf data/
bun run src/index.ts sync --since 7d
```

## Architecture

Built with TypeScript + Bun. All data stored locally on a persistent volume — no cloud sync service, no third-party access to your email. Storage layout and technical decisions: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Product vision: [`docs/VISION.md`](docs/VISION.md).

## Status

Active development. Core sync/index/search flows are working; CLI search interface is being expanded for agent-first workflows.

## License

MIT
