import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { SqliteDatabase } from "./index";
import { createTestDb, insertTestMessage } from "./test-helpers";
import { checkSchemaVersion, getDb, closeDb } from "./index";
import { SCHEMA_VERSION } from "./schema";

describe("database schema", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  describe("tables", () => {
    it("creates all expected tables", () => {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        .all() as { name: string }[];

      const names = tables.map((t) => t.name);
      expect(names).toContain("messages");
      expect(names).toContain("threads");
      expect(names).toContain("attachments");
      expect(names).toContain("people");
      expect(names).toContain("sync_state");
      expect(names).toContain("sync_windows");
      expect(names).toContain("sync_summary");
    });

    it("creates messages_fts virtual table", () => {
      const vtables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'"
        )
        .all() as { name: string }[];
      expect(vtables.length).toBe(1);
    });

    it("pre-seeds the sync_summary singleton row", () => {
      const row = db
        .prepare("SELECT * FROM sync_summary WHERE id = 1")
        .get() as { id: number; total_messages: number } | null;
      expect(row).not.toBeNull();
      expect(row!.total_messages).toBe(0);
    });


    it("sync_summary has owner_pid column", () => {
      const cols = db
        .prepare("PRAGMA table_info(sync_summary)")
        .all() as { name: string }[];
      const names = cols.map((c) => c.name);
      expect(names).toContain("owner_pid");
      expect(names).toContain("is_running");
    });

  });

  describe("messages", () => {
    it("inserts and retrieves a message", () => {
      const messageId = insertTestMessage(db, {
        subject: "Hello world",
        fromAddress: "alice@example.com",
      });

      const row = db
        .prepare("SELECT * FROM messages WHERE message_id = ?")
        .get(messageId) as { subject: string; from_address: string } | null;

      expect(row).not.toBeNull();
      expect(row!.subject).toBe("Hello world");
      expect(row!.from_address).toBe("alice@example.com");
    });

    it("enforces message_id uniqueness", () => {
      insertTestMessage(db, { messageId: "<dup@example.com>" });
      expect(() =>
        insertTestMessage(db, { messageId: "<dup@example.com>" })
      ).toThrow();
    });
  });

  describe("FTS5 triggers", () => {
    it("indexes a message in FTS on insert", () => {
      insertTestMessage(db, { subject: "Invoice from Stripe" });

      const results = db
        .prepare("SELECT message_id FROM messages_fts WHERE messages_fts MATCH 'Invoice'")
        .all();
      expect(results.length).toBe(1);
    });

    it("removes a message from FTS on delete", () => {
      const messageId = insertTestMessage(db, { subject: "Temporary email" });

      db.prepare("DELETE FROM messages WHERE message_id = ?").run(messageId);

      const results = db
        .prepare(
          "SELECT message_id FROM messages_fts WHERE messages_fts MATCH 'Temporary'"
        )
        .all();
      expect(results.length).toBe(0);
    });

    it("updates FTS index when message is updated", () => {
      const messageId = insertTestMessage(db, { subject: "Old subject" });

      db.prepare("UPDATE messages SET subject = 'New subject' WHERE message_id = ?").run(messageId);

      const old = db
        .prepare(
          "SELECT message_id FROM messages_fts WHERE messages_fts MATCH 'Old'"
        )
        .all();
      expect(old.length).toBe(0);

      const updated = db
        .prepare(
          "SELECT message_id FROM messages_fts WHERE messages_fts MATCH 'New'"
        )
        .all();
      expect(updated.length).toBe(1);
    });
  });


  describe("indexes", () => {
    it("creates expected indexes", () => {
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name"
        )
        .all() as { name: string }[];

      const names = indexes.map((i) => i.name);
      expect(names).toContain("idx_messages_thread");
      expect(names).toContain("idx_messages_date");
      expect(names).toContain("idx_messages_folder");
      expect(names).toContain("idx_attachments_msg");
    });
  });

  describe("schema version", () => {
    let tempDir: string;
    let originalEnv: string | undefined;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "zmail-test-"));
      originalEnv = process.env.ZMAIL_HOME;
      process.env.ZMAIL_HOME = tempDir;
      closeDb(); // Close any existing DB connection
    });

    afterEach(() => {
      closeDb();
      if (originalEnv !== undefined) {
        process.env.ZMAIL_HOME = originalEnv;
      } else {
        delete process.env.ZMAIL_HOME;
      }
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("checkSchemaVersion returns false when no DB file exists", () => {
      expect(checkSchemaVersion()).toBe(false);
    });

    it("checkSchemaVersion returns false when DB has correct user_version", () => {
      // Create DB with correct version
      const db = getDb();
      const result = db.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(result.user_version).toBe(SCHEMA_VERSION);
      closeDb();

      expect(checkSchemaVersion()).toBe(false);
    });

    it("checkSchemaVersion returns true when DB has lower user_version", () => {
      // Create DB and set old version
      const db = getDb();
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
      closeDb();

      expect(checkSchemaVersion()).toBe(true);
    });

    it("getDb sets user_version to SCHEMA_VERSION on fresh DB", () => {
      const db = getDb();
      const result = db.prepare("PRAGMA user_version").get() as { user_version: number };
      expect(result.user_version).toBe(SCHEMA_VERSION);
    });
  });
});
