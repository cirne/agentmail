/**
 * Node.js version gate for zmail. Must stay free of ~/db and anything that imports node:sqlite.
 * Keep in sync with package.json → engines.node (currently >=22.16.0).
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/** Minimum Node for zmail: built-in node:sqlite with FTS5 in bundled SQLite. */
export const ZMAIL_MIN_NODE_MAJOR = 22;
export const ZMAIL_MIN_NODE_MINOR = 16;

const PKG_DIR = dirname(fileURLToPath(import.meta.url));

/** package.json one level up from this file (src/lib/ → repo root; dist/ layout matches after build). */
function packageJsonPath(): string {
  return join(PKG_DIR, "..", "..", "package.json");
}

export function getPackageVersion(): string {
  const raw = readFileSync(packageJsonPath(), "utf-8");
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? "0.0.0";
}

/** Testable predicate; pass process.version in production. */
export function isNodeVersionSupportedForZmail(versionString: string): boolean {
  const m = /^v(\d+)\.(\d+)/.exec(versionString);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major > ZMAIL_MIN_NODE_MAJOR) return true;
  if (major < ZMAIL_MIN_NODE_MAJOR) return false;
  return minor >= ZMAIL_MIN_NODE_MINOR;
}

export function isZmailNodeRuntimeSupported(): boolean {
  return isNodeVersionSupportedForZmail(process.version);
}

function printIncompatibleNodeRuntimeMessage(): void {
  const need = `${ZMAIL_MIN_NODE_MAJOR}.${ZMAIL_MIN_NODE_MINOR}`;
  console.error(`zmail requires Node.js ${need} or newer.`);
  console.error(`This Node is ${process.version} — too old for zmail’s built-in SQLite (node:sqlite) and FTS5 search.`);
  console.error("");
  console.error("Fix: upgrade Node, then reinstall if needed.");
  console.error(`  • nvm:    nvm install ${need} && nvm use`);
  console.error("  • binary: https://nodejs.org/ (Current or LTS ≥ " + need + ")");
  console.error("");
  console.error("After upgrading: run `node -v` and try `zmail` again.");
}

/** Call before any code path that loads node:sqlite. Exits 1 when unsupported. */
export function assertZmailNodeRuntime(): void {
  if (isZmailNodeRuntimeSupported()) return;
  printIncompatibleNodeRuntimeMessage();
  process.exit(1);
}
