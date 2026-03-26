import { DatabaseSync } from "node:sqlite";
import { wrapNodeSqlite } from "./node-sqlite-adapter";
import type { SqliteDatabase } from "./sqlite-types";
import { SCHEMA } from "./schema";

/** Open a fresh in-memory SQLite database with the full schema applied. */
export async function createTestDb(): Promise<SqliteDatabase> {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec(SCHEMA);
  raw.exec("INSERT OR IGNORE INTO sync_summary (id, total_messages) VALUES (1, 0)");
  return wrapNodeSqlite(raw);
}

/** Insert a minimal message row for use in tests. Returns the message_id. */
export async function insertTestMessage(
  db: SqliteDatabase,
  overrides: Partial<{
    messageId: string;
    threadId: string;
    subject: string;
    bodyText: string;
    fromAddress: string;
    fromName: string | null;
    toAddresses: string;
    ccAddresses: string;
    date: string;
    folder: string;
    uid: number;
  }> = {}
): Promise<string> {
  const messageId =
    overrides.messageId ?? `<test-${Math.random().toString(36).slice(2)}@example.com>`;
  const threadId = overrides.threadId ?? "thread-1";
  const subject = overrides.subject ?? "Test subject";
  const bodyText = overrides.bodyText ?? "Test body content";
  const fromAddress = overrides.fromAddress ?? "sender@example.com";
  const fromName = overrides.fromName ?? null;
  const toAddresses = overrides.toAddresses ?? "[]";
  const ccAddresses = overrides.ccAddresses ?? "[]";
  const date = overrides.date ?? new Date().toISOString();
  const folder = overrides.folder ?? "[Gmail]/All Mail";
  const uid = overrides.uid ?? 1;

  await (
    await db.prepare(
      `INSERT INTO messages
       (message_id, thread_id, folder, uid, from_address, from_name, to_addresses, cc_addresses, subject, body_text, date, raw_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'maildir/test.eml')`
    )
  ).run(messageId, threadId, folder, uid, fromAddress, fromName, toAddresses, ccAddresses, subject, bodyText, date);

  return messageId;
}

/** Insert an attachment row linked to an existing message (filename-ordered listing). */
export async function insertTestAttachment(
  db: SqliteDatabase,
  messageId: string,
  overrides: Partial<{
    filename: string;
    mimeType: string;
    size: number;
    storedPath: string;
  }> = {}
): Promise<void> {
  const filename = overrides.filename ?? "doc.pdf";
  const mimeType = overrides.mimeType ?? "application/pdf";
  const size = overrides.size ?? 0;
  const storedPath = overrides.storedPath ?? "attachments/test-msg/doc.pdf";
  await (
    await db.prepare(
      `INSERT INTO attachments (message_id, filename, mime_type, size, stored_path) VALUES (?, ?, ?, ?, ?)`
    )
  ).run(messageId, filename, mimeType, size, storedPath);
}
