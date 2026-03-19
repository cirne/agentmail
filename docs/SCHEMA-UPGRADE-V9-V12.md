# Schema upgrade: v9 → v12 (FTS5 / ask pipeline)

**Context:** Branches that bump `SCHEMA_VERSION` in `src/db/schema.ts` change SQLite layout and FTS5 columns. This project does **not** ship automatic migrations.

## What changed (high level)

- **FTS5 `messages_fts`:** `from_address` and `from_name` are indexed (no longer `UNINDEXED` only on those fields as in older layouts).
- **`attachment_text` column:** Aggregated attachment extracted text in FTS5, kept in sync via triggers on `attachments`.
- **Version:** `SCHEMA_VERSION` moved **9 → 12** across the plan/scatter experiment.

## Options for existing installs

1. **Full reset (simplest)**  
   Remove data dir and re-sync (see [db-dev skill](../../.cursor/skills/db-dev/SKILL.md)):
   ```bash
   rm -rf ~/.zmail/data/
   zmail sync --since …
   ```

2. **Manual SQL (advanced)**  
   If you must preserve the DB, you would need to recreate `messages_fts`, triggers, and backfill `attachment_text` consistently with `src/db/schema.ts`. This is error-prone; resetting is recommended unless you are debugging.

## Verification after upgrade

- `zmail stats` / `zmail status` show healthy counts.
- `zmail search "receipt" from:apple.com` (or equivalent) returns expected rows.
- `npm test` and, with API key, `npm run eval` pass.

See also: [`docs/EXPERIMENT-PLAN-SCATTER-SEARCH.md`](EXPERIMENT-PLAN-SCATTER-SEARCH.md), [`docs/ANALYSIS-PLAN-SCATTER-MERGE.md`](ANALYSIS-PLAN-SCATTER-MERGE.md).
