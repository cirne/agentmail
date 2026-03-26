/**
 * Async SQLite facade — implemented by Node.js built-in `node:sqlite` (DatabaseSync).
 * Promises yield on microtasks; I/O is synchronous SQLite via libsqlite linked in Node.
 */

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...params: unknown[]): Promise<SqliteRunResult>;
  get(...params: unknown[]): Promise<Record<string, unknown> | undefined>;
  all(...params: unknown[]): Promise<Record<string, unknown>[]>;
}

export interface SqliteDatabase {
  exec(sql: string): Promise<void>;
  prepare(sql: string): Promise<SqliteStatement>;
  close(): Promise<void>;
}
