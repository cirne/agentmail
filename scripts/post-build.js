#!/usr/bin/env node
// Post-build script: ensures dist/index.js has the correct shebang for npm bin entry

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const distIndex = join(process.cwd(), "dist", "index.js");

if (!existsSync(distIndex)) {
  console.error("Error: dist/index.js not found. Build may have failed.");
  process.exit(1);
}

let content = readFileSync(distIndex, "utf8");

// npm global bin invokes `node path/to/index.js` (shebang ignored); SQLite warning is suppressed in src/index.ts.
const shebang = "#!/usr/bin/env node\n";
if (content.startsWith("#!")) {
  content = content.replace(/^#![^\n]*\n/, shebang);
} else {
  content = shebang + content;
}
writeFileSync(distIndex, content);
console.log("✓ Set shebang on dist/index.js");
