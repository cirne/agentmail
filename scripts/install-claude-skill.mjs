#!/usr/bin/env node
/**
 * Install skills/zmail/ into Claude Code's user-level skills directory so /zmail is available
 * in any workspace (see https://docs.claude.com/en/docs/claude-code/skills ).
 *
 * Default: symlink repo → ~/.claude/skills/zmail (edits in the repo apply immediately).
 * Copy instead: ZMAIL_CLAUDE_SKILL_MODE=copy
 * Skip (e.g. CI): ZMAIL_SKIP_CLAUDE_SKILL=1
 *
 * Override destination:
 *   ZMAIL_CLAUDE_SKILL_DIR=/path/to/skills/zmail
 */

import { cpSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const src = join(repoRoot, "skills", "zmail");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run") || args.has("-n");
const help = args.has("--help") || args.has("-h");

if (help) {
  console.log(`Usage: node scripts/install-claude-skill.mjs [--dry-run]

Installs this repo's skills/zmail/ (SKILL.md + references/) for Claude Code.

Default: symlink from this repo to ~/.claude/skills/zmail

Environment:
  ZMAIL_CLAUDE_SKILL_DIR     Destination directory (default: ~/.claude/skills/zmail)
  ZMAIL_CLAUDE_SKILL_MODE    copy | symlink (default: symlink)
  ZMAIL_SKIP_CLAUDE_SKILL    Set to 1 or true to skip (e.g. CI)

Examples:
  npm run install-skill:claude
  ZMAIL_CLAUDE_SKILL_MODE=copy npm run install-skill:claude
  npm run install-skill:claude -- --dry-run
`);
  process.exit(0);
}

if (process.env.ZMAIL_SKIP_CLAUDE_SKILL === "1" || process.env.ZMAIL_SKIP_CLAUDE_SKILL === "true") {
  console.log("Skipping Claude skill install (ZMAIL_SKIP_CLAUDE_SKILL is set).");
  process.exit(0);
}

if (!existsSync(src)) {
  console.error(`install-claude-skill: source missing: ${src}`);
  process.exit(1);
}
if (!statSync(src).isDirectory()) {
  console.error(`install-claude-skill: source is not a directory: ${src}`);
  process.exit(1);
}

const dest =
  process.env.ZMAIL_CLAUDE_SKILL_DIR?.trim() ||
  join(homedir(), ".claude", "skills", "zmail");

const modeRaw = (process.env.ZMAIL_CLAUDE_SKILL_MODE || "symlink").trim().toLowerCase();
const mode = modeRaw === "copy" ? "copy" : "symlink";

if (mode !== "copy" && modeRaw !== "symlink") {
  console.error(
    `install-claude-skill: ZMAIL_CLAUDE_SKILL_MODE must be copy or symlink (got: ${modeRaw})`
  );
  process.exit(1);
}

const srcResolved = resolve(src);

if (dryRun) {
  console.log(
    `[dry-run] would ${mode === "copy" ? "copy" : "symlink"}:\n  ${srcResolved}\n  -> ${dest}`
  );
  process.exit(0);
}

mkdirSync(dirname(dest), { recursive: true });

if (existsSync(dest)) {
  rmSync(dest, { recursive: true, force: true });
}

if (mode === "copy") {
  cpSync(src, dest, { recursive: true, force: true });
} else {
  try {
    symlinkSync(srcResolved, dest, "dir");
  } catch (err) {
    console.error(
      `install-claude-skill: symlink failed (${err?.message || err}). Try ZMAIL_CLAUDE_SKILL_MODE=copy`
    );
    process.exit(1);
  }
}

console.log(`Installed zmail skill for Claude Code (${mode}):\n  ${dest}`);
console.log("Start a new Claude Code session or reload skills so /zmail is available.");
