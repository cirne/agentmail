import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  detectMissingSchemaColumns,
  formatSchemaDriftError,
} from "./index";
import { SCHEMA } from "./schema";

describe("db schema drift preflight", () => {
  it("reports no drift for fresh schema", () => {
    const db = new Database(":memory:");
    db.run(SCHEMA);
    const missing = detectMissingSchemaColumns(db);
    expect(missing).toEqual([]);
    db.close();
  });

  it("detects missing messages.embedding_state in legacy DB", () => {
    const db = new Database(":memory:");
    db.run(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL,
        folder TEXT NOT NULL,
        uid INTEGER NOT NULL,
        labels TEXT NOT NULL DEFAULT '[]',
        from_address TEXT NOT NULL,
        from_name TEXT,
        to_addresses TEXT NOT NULL DEFAULT '[]',
        cc_addresses TEXT NOT NULL DEFAULT '[]',
        subject TEXT NOT NULL DEFAULT '',
        date TEXT NOT NULL,
        body_text TEXT NOT NULL DEFAULT '',
        raw_path TEXT NOT NULL,
        synced_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    const missing = detectMissingSchemaColumns(db);
    expect(missing.some((m) => m.table === "messages" && m.column === "embedding_state")).toBe(
      true
    );
    db.close();
  });

  it("formats a clear remediation message", () => {
    const message = formatSchemaDriftError(
      "./data/zmail.db",
      "./data",
      [
        {
          table: "messages",
          column: "embedding_state",
        },
      ]
    );

    expect(message).toContain("Detected schema drift");
    expect(message).toContain("messages.embedding_state");
    expect(message).toContain("rm -rf ./data");
    expect(message).not.toContain("sqlite3");
  });
});
