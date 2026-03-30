import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { resolveZmailSpawnArgs } from "./zmail-child-process";

describe("resolveZmailSpawnArgs", () => {
  it("returns node + index.js when dist layout is present", () => {
    const libDir = dirname(fileURLToPath(import.meta.url));
    const pkgRoot = dirname(libDir);
    const indexJs = join(pkgRoot, "index.js");

    const { executable, args } = resolveZmailSpawnArgs(["--", "sync", "--foreground"]);

    if (existsSync(indexJs)) {
      expect(executable).toBe(process.execPath);
      expect(args[0]).toBe(indexJs);
      expect(args).toEqual([indexJs, "--", "sync", "--foreground"]);
    } else {
      expect(executable).toBe("npx");
      expect(args[0]).toBe("tsx");
      expect(args[1]).toMatch(/index\.ts$/);
      expect(args.slice(2)).toEqual(["--", "sync", "--foreground"]);
    }
  });
});
