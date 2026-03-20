import { readFileSync } from "node:fs";
// Relative `.js` paths: this module loads from worker threads where `~` aliases are unreliable.
import { parseRawMessage } from "../sync/parse-message.js";
import type { ParsedMessage } from "../sync/parse-message.js";
import { readMessageMeta } from "../lib/message-meta.js";

export type MaildirParseJob = {
  filePath: string;
  filename: string;
  uid: number;
  relPath: string;
};

export type MaildirParseOk = {
  ok: true;
  parsedMsg: ParsedMessage;
  labelsJson: string;
  relPath: string;
  uid: number;
  filename: string;
};

export type MaildirParseFail = {
  ok: false;
  filename: string;
  error: string;
};

export type MaildirParseResult = MaildirParseOk | MaildirParseFail;

/**
 * Read one .eml from disk, parse MIME, and load sidecar metadata. Used on the main thread
 * and in worker threads (no SQLite).
 */
export async function runMaildirParseJob(job: MaildirParseJob): Promise<MaildirParseResult> {
  try {
    const raw = readFileSync(job.filePath);
    const parsedMsg = await parseRawMessage(raw);
    const meta = readMessageMeta(job.filePath);
    const labelsJson = meta.labels?.length ? JSON.stringify(meta.labels) : "[]";
    return {
      ok: true,
      parsedMsg,
      labelsJson,
      relPath: job.relPath,
      uid: job.uid,
      filename: job.filename,
    };
  } catch (err) {
    return {
      ok: false,
      filename: job.filename,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
