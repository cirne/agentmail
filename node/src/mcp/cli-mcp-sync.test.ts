/**
 * CLI/MCP sync test: ensures MCP tools expose the same option contract as the CLI/layers.
 * When you add a new search or who option that should be available via MCP, update:
 * 1. The layer (SearchOptions / WhoOptions) and CLI parsing
 * 2. The MCP tool schema and handler in src/mcp/index.ts
 * 3. MCP_SEARCH_MAIL_PARAM_KEYS / MCP_WHO_PARAM_KEYS in src/mcp/index.ts
 * 4. INTENDED_MCP_SEARCH_PARAMS / INTENDED_MCP_WHO_PARAMS below
 * If you forget (2) or (3), this test fails.
 */
import { describe, it, expect } from "vitest";
import {
  MCP_SEARCH_MAIL_PARAM_KEYS,
  MCP_WHO_PARAM_KEYS,
} from "./index";
import type { SearchOptions } from "~/search";
import type { WhoOptions } from "~/search/who";

const INTENDED_MCP_SEARCH_PARAMS: (keyof SearchOptions)[] = [
  "query",
  "limit",
  "offset",
  "fromAddress",
  "afterDate",
  "beforeDate",
  "includeThreads",
  "includeNoise",
];

/** MCP search_mail only — not on SearchOptions / searchWithMeta. */
const MCP_SEARCH_MAIL_ONLY_KEYS = ["resultFormat"] as const;

const INTENDED_MCP_WHO_PARAMS: (keyof WhoOptions)[] = [
  "query",
  "limit",
  "minSent",
  "minReceived",
  "includeNoreply",
  "enrich",
];

describe("CLI/MCP sync", () => {
  it("MCP search_mail params match intended contract", () => {
    const expected = [...INTENDED_MCP_SEARCH_PARAMS, ...MCP_SEARCH_MAIL_ONLY_KEYS].sort();
    const actual = [...MCP_SEARCH_MAIL_PARAM_KEYS].sort();
    expect(actual).toEqual(expected);
  });

  it("MCP who params match intended contract", () => {
    const expected = [...INTENDED_MCP_WHO_PARAMS].sort();
    const actual = [...MCP_WHO_PARAM_KEYS].sort();
    expect(actual).toEqual(expected);
  });
});
