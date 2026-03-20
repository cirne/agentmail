#!/usr/bin/env node
/**
 * Rebuild better-sqlite3 for the *current* Node so the native addon's
 * NODE_MODULE_VERSION matches the runtime (fixes ERR_DLOPEN_FAILED after
 * npm i -g with a mismatched prebuild).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "node_modules", "better-sqlite3");
if (!existsSync(pkg)) {
  process.exit(0);
}
const r = spawnSync("npm", ["rebuild", "better-sqlite3", "--omit=dev"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(r.status ?? 1);
