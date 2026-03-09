import type { SqliteDatabase } from "~/db";
import type { WhoResult } from "~/lib/types";
import { whoDynamic, type WhoOptions } from "./who-dynamic";

/**
 * Find people matching the query by dynamically querying messages.
 * This is the default implementation - it builds person profiles on-the-fly
 * from messages, ensuring results are always up-to-date and improve as more
 * data is indexed.
 * 
 * Uses fuzzy/phonetic matching for better discoverability (e.g., "geoff" matches "Geof").
 */
export async function who(db: SqliteDatabase, opts: WhoOptions): Promise<WhoResult> {
  return await whoDynamic(db, opts);
}

// Re-export WhoOptions for convenience
export type { WhoOptions };
