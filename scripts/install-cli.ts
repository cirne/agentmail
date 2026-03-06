#!/usr/bin/env node
// Install a wrapper script that runs zmail via `npx tsx src/index.ts` so the
// CLI uses the source tree (avoids compiled-binary issues e.g. PDF extraction).
//
// Usage: npm run install-cli  (or: npx tsx scripts/install-cli.ts)
//
// Default install dir: ~/.local/bin (override with ZMAIL_INSTALL_DIR).
// Ensure that directory is on your PATH so the installed `zmail` is found.
//
// The wrapper runs: npx tsx <projectRoot>/src/index.ts -- "$@"

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const installDir =
  process.env.ZMAIL_INSTALL_DIR ||
  join(process.env.HOME || "", ".local", "bin");
const destPath = join(installDir, "zmail");

// Find npm global bin directory
function getNpmGlobalBin(): string | null {
  try {
    const prefix = execSync("npm config get prefix", { encoding: "utf-8" }).trim();
    return join(prefix, "bin");
  } catch {
    return null;
  }
}

// Check if zmail exists in a given directory
function zmailExistsInDir(dir: string): boolean {
  try {
    return existsSync(join(dir, "zmail"));
  } catch {
    return false;
  }
}

// Escape for safe use inside single-quoted bash string
function escapeForBash(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/'/g, "'\\''");
}

const repoPath = escapeForBash(projectRoot);
const wrapper = `#!/usr/bin/env bash
set -e
ZMAIL_REPO='${repoPath}'
cd "$ZMAIL_REPO" && exec npx tsx src/index.ts "$@"
`;

mkdirSync(installDir, { recursive: true });
writeFileSync(destPath, wrapper, { mode: 0o755 });

console.log(`Installed zmail (source wrapper) → ${destPath}`);
console.log("");
console.log("The wrapper runs: npx tsx <repo>/src/index.ts <args>");
console.log("Repo path: " + projectRoot);
console.log("");

// Check for global npm installation
const npmGlobalBin = getNpmGlobalBin();
const hasGlobalZmail = npmGlobalBin && zmailExistsInDir(npmGlobalBin);
const pathEnv = process.env.PATH || "";
const installDirInPath = pathEnv.includes(installDir);
const npmGlobalBinInPath = npmGlobalBin && pathEnv.includes(npmGlobalBin);

// Check PATH ordering (only relevant if global zmail exists)
let pathOrderWarning = false;
if (hasGlobalZmail && installDirInPath && npmGlobalBinInPath && npmGlobalBin) {
  const pathParts = pathEnv.split(":");
  const installDirIndex = pathParts.indexOf(installDir);
  const npmGlobalBinIndex = pathParts.indexOf(npmGlobalBin);
  if (npmGlobalBinIndex >= 0 && installDirIndex >= 0 && npmGlobalBinIndex < installDirIndex) {
    pathOrderWarning = true;
  }
}

if (hasGlobalZmail) {
  console.log("⚠️  Detected global npm installation:");
  console.log(`   ${join(npmGlobalBin!, "zmail")}`);
  console.log("");
}

console.log("To use from another directory:");
if (!installDirInPath) {
  console.log("  1. Add the install dir to your PATH (put it FIRST to override npm global):");
  console.log(`     export PATH="${installDir}:$PATH"`);
  console.log("  2. Add this to your shell profile (~/.zshrc, ~/.bashrc, etc.) to make it permanent");
  console.log("  3. From that directory, run: zmail <command>");
  if (hasGlobalZmail) {
    console.log("");
    console.log("  ⚠️  IMPORTANT: Put ~/.local/bin FIRST in PATH to override the global installation");
  }
} else if (pathOrderWarning) {
  console.log("  ⚠️  WARNING: npm global bin comes before ~/.local/bin in PATH");
  console.log("  The wrapper may not override the global installation.");
  console.log("  Update your PATH to put ~/.local/bin FIRST:");
  console.log(`     export PATH="${installDir}:$PATH"`);
  console.log("  (Remove ~/.local/bin from its current position first)");
} else {
  console.log("  ✓ Run: zmail <command>");
  if (hasGlobalZmail && !pathOrderWarning) {
    console.log("  ✓ The wrapper will override the global npm installation");
  }
}
console.log("  (Config and data dir: ~/.zmail by default, or set ZMAIL_HOME.)");
console.log("");
console.log("To reinstall after moving the repo, run install-cli again from the new path.");