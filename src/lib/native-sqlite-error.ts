/**
 * better-sqlite3 loads a native `.node` binary tied to Node's NODE_MODULE_VERSION.
 * Mismatch surfaces when global install used a different Node than the runtime, etc.
 */

import { formatNodeAbiMismatchExplanation } from "./node-module-version";

export function isNodeNativeAddonAbiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /NODE_MODULE_VERSION/.test(msg) ||
    /was compiled against a different Node\.js version/.test(msg) ||
    /better_sqlite3\.node/.test(msg) ||
    /ERR_DLOPEN_FAILED/.test(msg)
  );
}

/** stderr hint for distributed installs (npm -g) and local dev rebuild. */
export function printBetterSqliteAbiMismatchHint(errOrMessage?: unknown): void {
  const msg =
    typeof errOrMessage === "string"
      ? errOrMessage
      : errOrMessage instanceof Error
        ? errOrMessage.message
        : "";
  const abiLines = msg ? formatNodeAbiMismatchExplanation(msg) : [];
  console.error("");
  for (const line of abiLines) {
    console.error(line);
  }
  if (abiLines.length > 0) {
    console.error("");
  }
  console.error(
    "The SQLite native addon was built for a different Node.js version. If you installed zmail from npm, reinstall:"
  );
  console.error("  npm install -g @cirne/zmail");
  console.error(
    "If you run from a git clone, use the same Node as when you installed dependencies, then: npm rebuild better-sqlite3"
  );
}
