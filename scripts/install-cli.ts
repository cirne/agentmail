#!/usr/bin/env node
// Install a wrapper script that runs zmail via the same Node binary that ran
// this installer + local tsx (`node_modules/tsx/dist/cli.mjs`), so native deps
// (e.g. better-sqlite3) match the runtime even when PATH/`npx` would pick another Node.
//
// Usage: npm run install-cli  (or: npx tsx scripts/install-cli.ts)
//
// Default install dir: ~/.local/bin (override with ZMAIL_INSTALL_DIR).
// Ensure that directory is on your PATH so the installed `zmail` is found.
//
// The wrapper runs: <node from install> <projectRoot>/node_modules/tsx/dist/cli.mjs <projectRoot>/src/index.ts -- "$@"

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
const nodePath = escapeForBash(process.execPath);
const tsxCli = join(projectRoot, "node_modules/tsx/dist/cli.mjs");
const tsxCliRel = "node_modules/tsx/dist/cli.mjs";

if (!existsSync(tsxCli)) {
  console.error(
    "install-cli: missing local tsx. Run `npm install` in the repo, then re-run install-cli."
  );
  process.exit(1);
}

const wrapper = `#!/usr/bin/env bash
set -e
ZMAIL_REPO='${repoPath}'
NODE_BIN='${nodePath}'
# Pinned Node — not affected by which \`node\` is first on PATH.
if [[ ! -x "\$NODE_BIN" ]]; then
  echo "zmail wrapper: pinned Node is missing or not executable:" >&2
  echo "  \$NODE_BIN" >&2
  echo "Re-run from the zmail repo: npm run install-cli" >&2
  echo "(Use the Node you use for npm install there.)" >&2
  exit 1
fi
cd "\$ZMAIL_REPO" && exec "\$NODE_BIN" "\$ZMAIL_REPO/${tsxCliRel}" "\$ZMAIL_REPO/src/index.ts" -- "\$@"
`;

mkdirSync(installDir, { recursive: true });
writeFileSync(destPath, wrapper, { mode: 0o755 });

console.log(`Installed zmail (source wrapper) → ${destPath}`);
console.log("");
console.log(
  "The wrapper runs: <this Node> <repo>/node_modules/tsx/dist/cli.mjs <repo>/src/index.ts <args>"
);
console.log("Node pinned to: " + process.execPath);
console.log("Repo path: " + projectRoot);
console.log(
  "(Default `node` on PATH does not matter; the wrapper always uses the path above.)"
);
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