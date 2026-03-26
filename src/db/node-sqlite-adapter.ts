import { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase, SqliteRunResult, SqliteStatement } from "./sqlite-types";

type StatementSync = ReturnType<DatabaseSync["prepare"]>;

function runResult(r: { changes: number | bigint; lastInsertRowid: number | bigint }): SqliteRunResult {
  const changes = typeof r.changes === "bigint" ? Number(r.changes) : r.changes;
  const lid = r.lastInsertRowid;
  const lastInsertRowid =
    typeof lid === "bigint"
      ? lid <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(lid)
        : lid
      : lid;
  return { changes, lastInsertRowid };
}

class NodeSqliteStatement implements SqliteStatement {
  constructor(private readonly stmt: StatementSync) {}

  run(...params: unknown[]): Promise<SqliteRunResult> {
    const s = this.stmt as { run: (...p: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint } };
    return Promise.resolve(runResult(s.run(...params)));
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

/** Wrap Node.js built-in `node:sqlite` DatabaseSync in the async SqliteDatabase facade. */
export function wrapNodeSqlite(db: DatabaseSync): SqliteDatabase {
  return {
    exec(sql: string) {
      return Promise.resolve().then(() => {
        db.exec(sql);
      });
    },
    prepare(sql: string) {
      return Promise.resolve(new NodeSqliteStatement(db.prepare(sql)));
    },
    close() {
      return Promise.resolve().then(() => {
        db.close();
      });
    },
  };
}
