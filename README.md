# agentmail

Email as a queryable dataset for AI agents.

Modern email systems are human-first — designed around inbox browsing and manual workflows. **agentmail** reimagines email as a structured, searchable dataset with a native interface for AI agents.

## What it does

- Syncs email from Gmail (and any IMAP provider) to a local indexed store
- Exposes a native CLI and MCP server for agent tool access
- Enables natural language queries over your full email history and attachments
- Extracts and indexes attachment content (PDF, DOCX, XLSX, and more)

```bash
agentmail search "contract from kirsten last month"
agentmail thread th_8473
agentmail attachments read att_291   # returns PDF content as markdown
```

## Architecture

Built with TypeScript + Bun. All data stored locally on a persistent volume — no cloud sync service, no third-party access to your email.

```
/data
├── maildir/        raw .eml files (source of truth)
├── agentmail.db    SQLite: metadata, full-text search, sync state
└── vectors/        LanceDB: semantic embeddings
```

See [`docs/VISION.md`](docs/VISION.md) for the product vision and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for technical decisions.

## Status

Early development. Not yet ready for general use.

## License

MIT
