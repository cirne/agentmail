import type { SyncResult } from "~/sync";
import type { RefreshPreviewRow } from "~/lib/refresh-preview";

export type { RefreshPreviewRow };

/** Visual separator between messages in --text output (refresh / inbox). */
const MESSAGE_SEPARATOR = "─".repeat(72);

/** Soft-wrap very long single lines in text preview (chars). */
const TEXT_WRAP_WIDTH = 100;

function wrapLine(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > width) {
    let breakAt = rest.lastIndexOf(" ", width);
    if (breakAt <= width * 0.5) breakAt = width;
    out.push(rest.slice(0, breakAt).trimEnd());
    rest = rest.slice(breakAt).trimStart();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

function printIndentedBlock(title: string, body: string): void {
  const trimmed = body.trim();
  if (!trimmed) return;
  console.log(`${title}`);
  for (const para of trimmed.split(/\n/)) {
    for (const wrapped of wrapLine(para, TEXT_WRAP_WIDTH)) {
      console.log(`  ${wrapped}`);
    }
  }
}

/** Same shape as historical `zmail refresh` stdout JSON; optional inbox metadata in `extras`. */
export function buildRefreshStylePayload(
  syncResult: SyncResult,
  newMail: RefreshPreviewRow[],
  extras?: Record<string, unknown>
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    synced: syncResult.synced,
    messagesFetched: syncResult.messagesFetched,
    bytesDownloaded: syncResult.bytesDownloaded,
    durationMs: syncResult.durationMs,
    bandwidthBytesPerSec: syncResult.bandwidthBytesPerSec,
    messagesPerMinute: syncResult.messagesPerMinute,
    newMail,
    ...(extras ?? {}),
  };
  if (syncResult.earlyExit) output.earlyExit = true;
  return output;
}

export function emptySyncResult(): SyncResult {
  return {
    synced: 0,
    messagesFetched: 0,
    bytesDownloaded: 0,
    durationMs: 0,
    bandwidthBytesPerSec: 0,
    messagesPerMinute: 0,
    logPath: "",
  };
}

export function printRefreshStyleOutput(
  syncResult: SyncResult,
  newMail: RefreshPreviewRow[],
  options: {
    forceText: boolean;
    /** Section title (e.g. "New mail:" vs "Inbox:"). */
    previewTitle: string;
    extras?: Record<string, unknown>;
    /** When true, text mode skips IMAP sync lines (e.g. `inbox` without `--refresh`). */
    omitRefreshMetrics?: boolean;
  }
): void {
  const { forceText, previewTitle, extras, omitRefreshMetrics } = options;
  const output = buildRefreshStylePayload(syncResult, newMail, extras);

  if (forceText) {
    const sec = (syncResult.durationMs / 1000).toFixed(2);
    const mb = (syncResult.bytesDownloaded / (1024 * 1024)).toFixed(2);
    const kbps = (syncResult.bandwidthBytesPerSec / 1024).toFixed(1);
    console.log("");
    if (!omitRefreshMetrics) {
      if (syncResult.earlyExit) console.log("No new messages (skipped fetch).");
      console.log("Refresh metrics:");
      console.log(`  messages:  ${syncResult.synced} new, ${syncResult.messagesFetched} fetched`);
      console.log(`  downloaded: ${mb} MB (${syncResult.bytesDownloaded} bytes)`);
      console.log(`  bandwidth: ${kbps} KB/s`);
      console.log(`  throughput: ${Math.round(syncResult.messagesPerMinute)} msg/min`);
      console.log(`  duration:  ${sec}s`);
    }
    if (omitRefreshMetrics && newMail.length === 0) {
      console.log("No notable messages in this window.");
    }
    if (newMail.length > 0) {
      console.log("");
      console.log(previewTitle);
      for (let i = 0; i < newMail.length; i++) {
        const r = newMail[i]!;
        console.log("");
        console.log(MESSAGE_SEPARATOR);
        const fromLine = (r.fromName ? `${r.fromName} ` : "") + `<${r.fromAddress}>`;
        console.log(`Date:    ${r.date}`);
        console.log(`From:    ${fromLine}`);
        console.log(`Subject: ${r.subject}`);
        console.log(`Id:      ${r.messageId}`);
        if (r.attachments && r.attachments.length > 0) {
          console.log("Attachments:");
          for (const a of r.attachments) {
            console.log(`  ${a.index}. ${a.filename} (${a.mimeType})`);
          }
        }
        if (r.note) {
          const noteOneLine = r.note.replace(/\s+/g, " ").trim();
          console.log(`Note:    ${noteOneLine}`);
        }
        printIndentedBlock("Preview:", r.snippet);
      }
      console.log("");
      console.log(MESSAGE_SEPARATOR);
    }
  } else {
    const payload = omitRefreshMetrics
      ? { newMail, ...(extras ?? {}) }
      : output;
    console.log(JSON.stringify(payload, null, 2));
  }
}
