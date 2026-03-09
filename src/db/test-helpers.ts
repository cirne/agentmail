import Database from "better-sqlite3";
import type { SqliteDatabase } from "./index";
import { SCHEMA } from "./schema";

/** Open a fresh in-memory SQLite database with the full schema applied. */
export function createTestDb(): SqliteDatabase {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  db.exec("INSERT OR IGNORE INTO sync_summary (id, total_messages) VALUES (1, 0)");
  return db;
}

/** Insert a minimal message row for use in tests. Returns the message_id. */
export function insertTestMessage(
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
): string {
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

  db.prepare(
    `INSERT INTO messages
       (message_id, thread_id, folder, uid, from_address, from_name, to_addresses, cc_addresses, subject, body_text, date, raw_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'maildir/test.eml')`
  ).run(messageId, threadId, folder, uid, fromAddress, fromName, toAddresses, ccAddresses, subject, bodyText, date);

  return messageId;
}
