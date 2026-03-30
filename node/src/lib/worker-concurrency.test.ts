import { describe, it, expect, afterEach } from "vitest";
import { DEFAULT_ZMAIL_WORKER_CONCURRENCY, getZmailWorkerConcurrency } from "./worker-concurrency";

describe("getZmailWorkerConcurrency", () => {
  it("default constant is 8", () => {
    expect(DEFAULT_ZMAIL_WORKER_CONCURRENCY).toBe(8);
  });

  const keys = ["ZMAIL_WORKER_CONCURRENCY", "ZMAIL_REBUILD_PARSE_CONCURRENCY"] as const;

  afterEach(() => {
    for (const k of keys) {
      delete process.env[k];
    }
  });

  it("uses ZMAIL_WORKER_CONCURRENCY when set", () => {
    process.env.ZMAIL_WORKER_CONCURRENCY = "4";
    expect(getZmailWorkerConcurrency()).toBe(4);
  });

  it("prefers ZMAIL_WORKER_CONCURRENCY over legacy rebuild var", () => {
    process.env.ZMAIL_WORKER_CONCURRENCY = "2";
    process.env.ZMAIL_REBUILD_PARSE_CONCURRENCY = "9";
    expect(getZmailWorkerConcurrency()).toBe(2);
  });

  it("falls back to ZMAIL_REBUILD_PARSE_CONCURRENCY", () => {
    process.env.ZMAIL_REBUILD_PARSE_CONCURRENCY = "3";
    expect(getZmailWorkerConcurrency()).toBe(3);
  });

  it("returns a positive default under Vitest when env unset", () => {
    expect(getZmailWorkerConcurrency()).toBe(1);
  });
});
