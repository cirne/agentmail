import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, afterEach } from "vitest";
import { wrapNodeSqlite } from "./node-sqlite-adapter";

describe("wrapNodeSqlite", () => {
  let raw: DatabaseSync | undefined;

  afterEach(() => {
    try {
      raw?.close();
    } catch {
      /* already closed */
    }
    raw = undefined;
  });

  it("exec, prepare, run, get, and all resolve via Promises", async () => {
    raw = new DatabaseSync(":memory:");
    const db = wrapNodeSqlite(raw);

    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)");
    const ins = await db.prepare("INSERT INTO t (x) VALUES (?)");
    const runResult = await ins.run("hello");
    expect(runResult.changes).toBe(1);

    const one = await (await db.prepare("SELECT x FROM t WHERE id = 1")).get();
    expect(one).toEqual({ x: "hello" });

    await (await db.prepare("INSERT INTO t (x) VALUES (?)")).run("world");
    const rows = await (await db.prepare("SELECT x FROM t ORDER BY id")).all();
    expect(rows).toEqual([{ x: "hello" }, { x: "world" }]);
  });

  it("close resolves", async () => {
    raw = new DatabaseSync(":memory:");
    const db = wrapNodeSqlite(raw);
    await db.close();
  });
});
