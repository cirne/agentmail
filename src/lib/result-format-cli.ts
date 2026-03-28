import type { SearchResultFormatPreference } from "~/search/search-json-format";

/**
 * Validates the token after `--result-format` (same rules as `zmail search` and `zmail draft list`).
 */
export function parseCliResultFormatMode(modeRaw: string): SearchResultFormatPreference {
  const mode = modeRaw.toLowerCase();
  if (mode !== "auto" && mode !== "full" && mode !== "slim") {
    throw new Error(`Invalid --result-format: "${mode}". Use auto, full, or slim.`);
  }
  return mode as SearchResultFormatPreference;
}
