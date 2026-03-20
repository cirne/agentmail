# Scripts Directory

This directory contains development and maintenance scripts for zmail.

## Script Categories

### Production/Workflow Scripts (Keep)

These scripts are part of the development workflow and should be kept:

- **`install-cli.ts`** — Install wrapper script to run zmail from source
  - Usage: `npm run install-cli`
  - Documented in: `AGENTS.md`
  - Purpose: Allows running `zmail` from any directory using source code

- **`install-openclaw-skill.mjs`** — Copy `skills/zmail/` into OpenClaw’s skill directory on this machine
  - Usage: `npm run install-skill:openclaw` (optional: `OPENCLAW_ZMAIL_SKILL_DIR`, `--dry-run`)
  - Documented in: `skills/README.md` (see [OpenClaw creating skills](https://docs.openclaw.ai/tools/creating-skills))

- **`reset.ts`** — Wipe local data and start fresh
  - Usage: `npm run reset` (if added to package.json) or `npx tsx scripts/reset.ts`
  - Purpose: Dev utility to clear DB, maildir, and vectors for fresh start

### Maintenance Scripts

**Note:** The eval suite automatically builds its test database in `beforeAll()`, so no separate rebuild script is needed for eval fixtures.

**Note:** The `people` table exists in the schema but is not used — the `who` command builds profiles dynamically from messages on-the-fly, so no rebuild script is needed.

### Fixture Generation Scripts (Rarely Used)

These scripts generate or modify test fixtures. They're already been run (fixtures exist), but kept for rare regeneration needs:

- **`generate-fixtures-from-inbox.ts`** — Generate realistic eval fixtures from actual inbox
  - Usage: `npx tsx scripts/generate-fixtures-from-inbox.ts`
  - Purpose: Sample real inbox data and create anonymized fixtures
  - When to use: **Rarely** — when updating eval fixtures to match current inbox patterns (maybe quarterly)
  - Status: ✅ Already run — `realistic-inbox.yaml` exists with 500 messages
  - Output: `tests/ask/realistic-inbox.yaml`

- **`add-realistic-names.ts`** — Add realistic names to fixture files
  - Usage: `npx tsx scripts/add-realistic-names.ts`
  - Purpose: Replace `Person{N}` placeholders with realistic first/last names
  - When to use: **Rarely** — only after regenerating fixtures with `generate-fixtures-from-inbox.ts`
  - Status: ✅ Already run — fixtures have realistic names (150+ unique names)
  - Updates: `tests/ask/realistic-inbox.yaml`

### Temporary/Debug Scripts

**Note:** One-time debugging scripts have been removed from the repo. The eval suite automatically builds the test database in `beforeAll()`, so no separate rebuild script is needed.

## Script Lifecycle

### When to Keep a Script

Keep scripts that:
- Are part of the development workflow (`install-cli.ts`)
- Generate or modify fixtures that may need regeneration (`generate-fixtures-from-inbox.ts`, `add-realistic-names.ts`)
- Are documented in `AGENTS.md` or other docs

### When to Delete a Script

Delete scripts that:
- Were created for one-time debugging tasks (e.g., `check-apple-fixtures.ts`)
- Are no longer needed after a task is complete
- Have been superseded by more general tools

### Script Naming Conventions

- **`*-fixtures.ts`** — Fixture generation/modification scripts
- **`rebuild-*.ts`** — Database rebuild scripts
- **`check-*.ts`** — One-time verification scripts (often temporary)
- **`install-*.ts`** — Installation/setup scripts

## Adding New Scripts

When creating a new script:

1. **Add a shebang:** `#!/usr/bin/env tsx` for TypeScript scripts
2. **Add a header comment** explaining purpose and usage
3. **Update this README** with the script's category and purpose
4. **Consider adding to package.json** if it's part of the workflow
5. **Document in AGENTS.md** if it's a developer-facing tool

## Running Scripts

Most scripts can be run directly:
```bash
npx tsx scripts/script-name.ts
```

Or if added to `package.json`:
```bash
npm run script-name
```
