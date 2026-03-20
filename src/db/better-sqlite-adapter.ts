import Database from "better-sqlite3";
import type { SqliteDatabase, SqliteRunResult, SqliteStatement } from "./sqlite-types";

type NativeStatement = ReturnType<InstanceType<typeof Database>["prepare"]>;

class BetterSqliteStatement implements SqliteStatement {
  constructor(private readonly stmt: NativeStatement) {}

  run(...params: unknown[]): Promise<SqliteRunResult> {
    const s = this.stmt as { run: (...p: unknown[]) => SqliteRunResult };
    return Promise.resolve(s.run(...params));
  }

  get(...params: unknown[]): Promise<Record<string, unknown> | undefined> {
    const s = this.stmt as { get: (...p: unknown[]) => Record<string, unknown> | undefined };
    return Promise.resolve(s.get(...params));
  }

  all(...params: unknown[]): Promise<Record<string, unknown>[]> {
    const s = this.stmt as { all: (...p: unknown[]) => Record<string, unknown>[] };
    return Promise.resolve(s.all(...params));
  }
}

export function wrapBetterSqlite3(db: InstanceType<typeof Database>): SqliteDatabase {
  return {
    exec(sql: string) {
      return Promise.resolve().then(() => {
        db.exec(sql);
      });
    },
    prepare(sql: string) {
      return Promise.resolve(new BetterSqliteStatement(db.prepare(sql)));
    },
    close() {
      return Promise.resolve().then(() => {
        db.close();
      });
    },
  };
}
