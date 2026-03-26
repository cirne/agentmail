/**
 * Ensure better-sqlite3's native `.node` matches the *running* Node (NODE_MODULE_VERSION).
 * postinstall rebuild only runs at npm install time; users often switch Node later.
 * Side-effect module: import before any `import ... from "better-sqlite3"`.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isNodeNativeAddonAbiError, printBetterSqliteAbiMismatchHint } from "./native-sqlite-error";

function findZmailPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { name?: string };
        if (pkg.name === "@cirne/zmail") return dir;
      } catch {
        // ignore invalid package.json
      }
    }
    dir = dirname(dir);
  }
  throw new Error("@cirne/zmail package root not found (needed to rebuild better-sqlite3)");
}

function tryLoadBetterSqlite(req: ReturnType<typeof createRequire>): void {
  req("better-sqlite3");
}

function runEnsure(): void {
  if (process.env.ZMAIL_SKIP_NATIVE_SQLITE_ENSURE === "1") {
    return;
  }
  const require = createRequire(import.meta.url);
  let abiMismatchErr: unknown;
  try {
    tryLoadBetterSqlite(require);
    return;
  } catch (err) {
    if (!isNodeNativeAddonAbiError(err)) throw err;
    abiMismatchErr = err;
  }

  const root = findZmailPackageRoot();
  console.error("Rebuilding better-sqlite3 for the current Node.js version...");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npm, ["rebuild", "better-sqlite3", "--omit=dev"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    printBetterSqliteAbiMismatchHint(abiMismatchErr);
    throw new Error(`npm rebuild better-sqlite3 failed (exit ${r.status ?? "unknown"})`);
  }

  const resolved = require.resolve("better-sqlite3");
  if (require.cache[resolved]) {
    delete require.cache[resolved];
  }
  try {
    tryLoadBetterSqlite(require);
  } catch (err) {
    if (isNodeNativeAddonAbiError(err)) printBetterSqliteAbiMismatchHint(err);
    throw err;
  }
}

runEnsure();
