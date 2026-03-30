import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/**
 * How to spawn a second zmail process (background sync, wizard) using the same
 * install layout as this build. Global npm installs ship `dist/index.js` only;
 * spawning `npx tsx dist/index.ts` exits immediately (no sync, no log file).
 */
export function resolveZmailSpawnArgs(argvSuffix: string[]): { executable: string; args: string[] } {
  const libDir = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = dirname(libDir);
  const indexJs = join(pkgRoot, "index.js");
  const indexTs = join(pkgRoot, "index.ts");

  if (existsSync(indexJs)) {
    return { executable: process.execPath, args: [indexJs, ...argvSuffix] };
  }
  if (existsSync(indexTs)) {
    return { executable: "npx", args: ["tsx", indexTs, ...argvSuffix] };
  }

  throw new Error(
    `Cannot find zmail entrypoint (expected ${indexJs} or ${indexTs}). Reinstall or run from the package root.`,
  );
}
