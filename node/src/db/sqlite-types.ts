/**
 * Async SQLite facade — implemented by better-sqlite3 (file-backed) today.
 * Promises yield on microtasks; I/O remains OS-paged like native SQLite.
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
