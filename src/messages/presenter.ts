/**
 * Shared message presenter module for CLI and MCP.
 * Provides message shaping and formatting functions that can be used by both interfaces
 * without creating layering dependencies.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { getDb, type SqliteDatabase } from "~/db";
import { config } from "~/lib/config";
import { parseRawMessage } from "~/sync/parse-message";
import { htmlToMarkdown } from "~/lib/content-normalize";
import { formatMessageLlmFriendly, type ShapedContent } from "~/cli/format-message";
import { listAttachmentsForMessage } from "~/attachments/list-for-message";

/**
 * Message row from database - matches the messages table schema.
 */
export interface MessageRow {
  id: number;
  message_id: string;
  thread_id: string;
  folder: string;
  uid: number;
  labels: string;
  from_address: string;
  from_name: string | null;
  to_addresses: string;
  cc_addresses: string;
  subject: string;
  date: string;
  body_text: string;
  raw_path: string;
  synced_at: string;
}

/**
 * Read raw email file from maildir path.
 */
function readRawEmail(rawPath: string): Buffer | null {
  try {
    const absPath = join(config.maildirPath, rawPath);
    return readFileSync(absPath);
  } catch {
    return null;
  }
}

/**
 * Shape a message row into a structured output format with attachments and content.
 * This function handles:
 * - Loading attachments from the database
 * - Reading raw email files when needed
 * - Parsing HTML content to markdown
 * - Formatting content based on raw flag
 *
 * @param message Message row from database
 * @param raw If true, include raw EML content instead of parsed markdown
 * @param db Optional database instance (defaults to `await getDb()` when omitted)
 * @returns Shaped message object ready for formatting or JSON output
 */
export async function formatMessageForOutput(
  message: MessageRow,
  raw: boolean,
  db?: SqliteDatabase
): Promise<Record<string, unknown> & ShapedContent> {
  const database = db ?? (await getDb());
  const attachments = await listAttachmentsForMessage(database, message.message_id);

  if (raw) {
    const rawEmail = readRawEmail(message.raw_path);
    return {
      ...message,
      content: {
        format: "raw",
        source: "eml",
        eml: rawEmail ? rawEmail.toString("utf8") : null,
      },
      attachments: attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mime_type,
        size: a.size,
        extracted: a.extracted_text !== null,
      })),
    };
  }

  const { body_text, ...rest } = message;
  let body = (body_text ?? "").trim();
  let source: "body_text" | "html" | "text" | "empty" = body ? "body_text" : "empty";

  if (!body && message.raw_path) {
    const rawEmail = readRawEmail(message.raw_path);
    if (rawEmail) {
      try {
        const parsed = await parseRawMessage(rawEmail);
        if (parsed.bodyHtml) {
          const markdown = htmlToMarkdown(parsed.bodyHtml);
          if (markdown) {
            body = markdown;
            source = "html";
          }
        }
        if (!body && parsed.bodyText) {
          body = (parsed.bodyText ?? "").trim();
          if (body) source = "text";
        }
      } catch (err) {
        // Log parsing errors for debugging
        const { logger } = await import("~/lib/logger");
        logger.warn("Failed to parse raw email for message", {
          messageId: message.message_id,
          rawPath: message.raw_path,
          error: err instanceof Error ? err.message : String(err),
        });
        // fall through to empty content
      }
    } else {
      // Log when raw email file can't be read
      const { logger } = await import("~/lib/logger");
      logger.warn("Could not read raw email file", {
        messageId: message.message_id,
        rawPath: message.raw_path,
      });
    }
  }

  // Ensure body is never null/undefined - use empty string if parsing failed
  const finalBody = body || "";

  return {
    ...rest,
    content: {
      format: source === "html" ? "markdown" : "text",
      source,
      markdown: finalBody,
    },
    attachments: attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mime_type,
      size: a.size,
      extracted: a.extracted_text !== null,
    })),
  };
}

/**
 * Format a shaped message into LLM-friendly text output.
 * Re-exports the formatMessageLlmFriendly function from format-message module.
 */
export { formatMessageLlmFriendly };
