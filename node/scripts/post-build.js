#!/usr/bin/env node
// Post-build script: ensures dist/index.js has the correct shebang for npm bin entry

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const distIndex = join(process.cwd(), "dist", "index.js");

if (!existsSync(distIndex)) {
  console.error("Error: dist/index.js not found. Build may have failed.");
  process.exit(1);
}

const content = readFileSync(distIndex, "utf8");

// Add shebang if not present
if (!content.startsWith("#!")) {
  writeFileSync(distIndex, "#!/usr/bin/env node\n" + content);
  console.log("✓ Added shebang to dist/index.js");
} else {
  console.log("✓ dist/index.js already has shebang");
}
