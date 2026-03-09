import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { SqliteDatabase } from "~/db";
import { insertTestMessage } from "~/db/test-helpers";

/**
 * Resolve relative date strings to ISO date strings.
 * Supports:
 * - "-7d" (7 days ago)
 * - "-0d" (now)
 * - "today+8h" (8am today)
 * - "today+14h" (2pm today)
 */
function resolveRelativeDate(dateStr: string): string {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  // Handle "today+Xh" format (e.g., "today+8h" = 8am today)
  if (dateStr.startsWith("today+")) {
    const match = dateStr.match(/today\+(\d+)h/);
    if (match) {
      const hours = parseInt(match[1], 10);
      const date = new Date(today);
      date.setHours(hours, 0, 0, 0);
      return date.toISOString();
    }
  }

  // Handle "-Nd" format (N days ago, or "-0d" = now)
  if (dateStr.startsWith("-") && dateStr.endsWith("d")) {
    const days = parseInt(dateStr.slice(1, -1), 10);
    const date = new Date(now);
    date.setDate(date.getDate() - days);
    return date.toISOString();
  }

  // Assume it's already an ISO string
  return dateStr;
}

/**
 * Eval fixture message definition.
 * messageId is optional - if not provided, a unique ID will be auto-generated.
 * All fields except subject, fromAddress, bodyText, and date are optional.
 */
interface EvalMessage {
  messageId?: string; // Optional - auto-generated if not provided
  subject: string;
  fromAddress: string;
  fromName?: string;
  bodyText: string;
  date: string; // Relative date (e.g., "-7d", "today+8h") or ISO string
  threadId?: string;
  toAddresses?: string; // JSON array string (default: "[]")
  ccAddresses?: string; // JSON array string (default: "[]")
  isNoise?: boolean; // Mark message as noise (default: false)
  labels?: string; // JSON array string of Gmail labels (default: "[]")
  attachments?: Array<{
    filename: string;
    mimeType: string;
    fixturePath?: string; // Path to fixture file relative to project root (e.g., "tests/attachments/fixtures/sales-data.xlsx")
    content?: string; // Direct content for small text attachments (mutually exclusive with fixturePath)
  }>;
}

interface EvalFixture {
  messages: EvalMessage[];
}

/**
 * Load eval fixtures from YAML files and insert into database.
 * Loads all *.yaml files from tests/ask/ directory and merges their messages.
 * Resolves relative dates and handles attachment insertion.
 */
export function loadEvalFixtures(db: SqliteDatabase): void {
  // Load all YAML files from tests/ask/ directory
  const fixturesDir = join(process.cwd(), "tests/ask");
  const yamlFiles = readdirSync(fixturesDir)
    .filter((file) => file.endsWith(".yaml"))
    .map((file) => join(fixturesDir, file));

  // Merge messages from all YAML files
  const allMessages: EvalMessage[] = [];
  for (const yamlPath of yamlFiles) {
    const yaml = readFileSync(yamlPath, "utf-8");
    const data = parseYaml(yaml) as EvalFixture;
    if (data.messages && Array.isArray(data.messages)) {
      allMessages.push(...data.messages);
    }
  }

  // Process all merged messages
  let messageCounter = 0;
  for (const msg of allMessages) {
    const date = resolveRelativeDate(msg.date);
    
    // Generate unique messageId if not provided
    // Use hash of subject + fromAddress + date to ensure consistency across test runs
    // but add counter to guarantee uniqueness even if content is identical
    let messageId = msg.messageId;
    if (!messageId) {
      const hashInput = `${msg.subject}|${msg.fromAddress}|${date}|${messageCounter}`;
      const hash = createHash("sha256").update(hashInput).digest("hex").slice(0, 16);
      messageId = `<eval-${hash}@zmail.test>`;
    }
    messageCounter++;
    
    // Insert message using test helper
    insertTestMessage(db, {
      messageId,
      subject: msg.subject,
      fromAddress: msg.fromAddress,
      fromName: msg.fromName ?? null,
      bodyText: msg.bodyText,
      date,
      threadId: msg.threadId ?? messageId, // Default threadId to messageId if not specified
      toAddresses: msg.toAddresses ?? "[]",
      ccAddresses: msg.ccAddresses ?? "[]",
    });

    // Update fields not supported by insertTestMessage
    if (msg.isNoise !== undefined || msg.labels !== undefined) {
      const updates: string[] = [];
      const values: unknown[] = [];
      
      if (msg.isNoise !== undefined) {
        updates.push("is_noise = ?");
        values.push(msg.isNoise ? 1 : 0);
      }
      
      if (msg.labels !== undefined) {
        updates.push("labels = ?");
        values.push(msg.labels);
      }
      
      values.push(messageId);
      db.prepare(
        `UPDATE messages SET ${updates.join(", ")} WHERE message_id = ?`
      ).run(...values);
    }

    // Insert attachments if present
    if (msg.attachments && msg.attachments.length > 0) {
      for (const att of msg.attachments) {
        let content: Buffer;
        
        if (att.fixturePath) {
          // Read from fixture file (path relative to project root)
          // Resolve to absolute path and ensure it's within project root (prevent directory traversal)
          const resolvedPath = resolve(process.cwd(), att.fixturePath);
          const relativePath = relative(process.cwd(), resolvedPath);
          if (relativePath.startsWith("..") || relativePath.startsWith("/")) {
            throw new Error(`Fixture path must be relative to project root: ${att.fixturePath}`);
          }
          content = readFileSync(resolvedPath);
        } else if (att.content) {
          // Use direct content (for small text attachments)
          content = Buffer.from(att.content, "utf-8");
        } else {
          throw new Error(`Attachment ${att.filename} must have either fixturePath or content`);
        }

        // Insert attachment row
        db.prepare(
          `INSERT INTO attachments (message_id, filename, mime_type, size, stored_path, extracted_text)
           VALUES (?, ?, ?, ?, ?, NULL)`
        ).run(
          messageId,
          att.filename,
          att.mimeType,
          content.length,
          `tests/fixtures/${att.filename}`, // Stored path (not used in tests, but required by schema)
        );
      }
    }
  }
}
