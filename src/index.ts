#!/usr/bin/env node
// Main entrypoint — routes to CLI commands or starts sync service.
// Help and setup are handled here so they work without loading config (no env required).

import { CLI_USAGE } from "~/lib/onboarding";
import { hasConfig } from "~/lib/config";

// When run as "tsx src/index.ts -- <command>", argv[2] is "--" and argv[3] is the command
const rest = process.argv.slice(2);
const command = rest[0] === "--" ? rest[1] : rest[0];
const args = rest[0] === "--" ? rest.slice(2) : rest.slice(1);

/** Emit onboarding hint on stderr and exit 1 when failure is due to missing config. */
function handleMissingConfig(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  const isMissingConfig = /Missing required|No config found|Run 'zmail setup'/.test(msg);
  if (isMissingConfig) {
    console.error("No config found. Run 'zmail setup' first.");
    process.exit(1);
  }
  throw err;
}

if (command === "--help" || command === "-h" || command === "help") {
  console.log(CLI_USAGE);
  process.exit(0);
}
if (command === "setup") {
  const noValidate = args.includes("--no-validate");
  const clean = args.includes("--clean");
  const yes = args.includes("--yes");
  const { runSetup } = await import("~/cli/setup");
  await runSetup({ noValidate, clean, yes });
  process.exit(0);
}

// Check for config before proceeding
if (!hasConfig()) {
  console.error("No config found. Run 'zmail setup' first.");
  process.exit(1);
}

if (command) {
  try {
    await import("~/cli");
  } catch (err) {
    handleMissingConfig(err);
  }
} else {
  try {
    const { runSync } = await import("~/sync");
    const { logger } = await import("~/lib/logger");
    logger.info("Starting zmail sync");
    runSync().catch((err) => {
      logger.error("Sync daemon crashed", { error: String(err) });
    });
  } catch (err) {
    handleMissingConfig(err);
  }
}
