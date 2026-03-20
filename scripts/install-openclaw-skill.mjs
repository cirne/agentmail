#!/usr/bin/env node
/**
 * Copy skills/zmail/ into an OpenClaw skill directory so the gateway picks it up
 * on the next session (see https://docs.openclaw.ai/tools/creating-skills ).
 *
 * Default destination: ~/.openclaw/skills/zmail (shared across agents on this machine).
 *
 * Override:
 *   OPENCLAW_ZMAIL_SKILL_DIR=/path/to/skills/zmail
 *
 * Examples for workspace-scoped install (per OpenClaw "Create your first skill"):
 *   OPENCLAW_ZMAIL_SKILL_DIR="$HOME/.openclaw/workspace/skills/zmail" npm run install-skill:openclaw
 */

import { cpSync, existsSync, mkdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const src = join(repoRoot, "skills", "zmail");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run") || args.has("-n");
const help = args.has("--help") || args.has("-h");

if (help) {
  console.log(`Usage: node scripts/install-openclaw-skill.mjs [--dry-run]

Copies this repo's skills/zmail/ (SKILL.md + references/) into OpenClaw.

Environment:
  OPENCLAW_ZMAIL_SKILL_DIR   Destination directory (default: ~/.openclaw/skills/zmail)

Examples:
  npm run install-skill:openclaw
  OPENCLAW_ZMAIL_SKILL_DIR="$HOME/.openclaw/workspace/skills/zmail" npm run install-skill:openclaw
  npm run install-skill:openclaw -- --dry-run
`);
  process.exit(0);
}

if (!existsSync(src)) {
  console.error(`install-openclaw-skill: source missing: ${src}`);
  process.exit(1);
}
if (!statSync(src).isDirectory()) {
  console.error(`install-openclaw-skill: source is not a directory: ${src}`);
  process.exit(1);
}

const dest =
  process.env.OPENCLAW_ZMAIL_SKILL_DIR?.trim() ||
  join(homedir(), ".openclaw", "skills", "zmail");

if (dryRun) {
  console.log(`[dry-run] would copy:\n  ${src}\n  -> ${dest}`);
  process.exit(0);
}

mkdirSync(dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true, force: true });
console.log(`Installed zmail skill:\n  ${dest}`);
console.log(
  "Start a new OpenClaw session or restart the gateway so skills reload (see OpenClaw docs)."
);
