/**
 * Sidecar metadata for messages stored alongside EML files in maildir.
 * 
 * Each EML file ({uid}_{messageId}.eml) can have a companion .meta.json file
 * ({uid}_{messageId}.meta.json) containing non-standard metadata that isn't
 * in the EML itself (e.g. IMAP labels, Gmail categories).
 * 
 * This is a generic catch-all — add new fields as needed without creating
 * additional sidecar files.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";

export interface MessageMeta {
  labels?: string[];
}

/**
 * Derive sidecar path from an EML path: replace .eml with .meta.json.
 */
export function metaPathForEml(emlPath: string): string {
  return emlPath.replace(/\.eml$/, ".meta.json");
}

/**
 * Write sidecar metadata alongside an EML file.
 * Silently skips if meta has no meaningful content.
 */
export function writeMessageMeta(emlPath: string, meta: MessageMeta): void {
  if (!meta.labels?.length) return;
  const metaPath = metaPathForEml(emlPath);
  writeFileSync(metaPath, JSON.stringify(meta), "utf-8");
}

/**
 * Read sidecar metadata for an EML file. Returns empty object if no sidecar exists.
 */
export function readMessageMeta(emlPath: string): MessageMeta {
  const metaPath = metaPathForEml(emlPath);
  if (!existsSync(metaPath)) return {};
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8")) as MessageMeta;
  } catch {
    return {};
  }
}
