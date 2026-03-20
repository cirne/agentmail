import { describe, it, expect, vi } from "vitest";
import {
  buildRefreshStylePayload,
  emptySyncResult,
  printRefreshStyleOutput,
} from "./refresh-output";
import type { SyncResult } from "~/sync";

describe("refresh-output", () => {
  it("emptySyncResult has zero metrics", () => {
    const e = emptySyncResult();
    expect(e.synced).toBe(0);
    expect(e.messagesFetched).toBe(0);
    expect(e.logPath).toBe("");
  });

  it("buildRefreshStylePayload matches refresh keys", () => {
    const sync: SyncResult = {
      synced: 2,
      messagesFetched: 2,
      bytesDownloaded: 100,
      durationMs: 500,
      bandwidthBytesPerSec: 10,
      messagesPerMinute: 60,
      logPath: "/tmp/log",
      earlyExit: true,
    };
    const newMail = [
      {
        messageId: "<a@b>",
        date: "2025-01-01T12:00:00.000Z",
        fromAddress: "a@b",
        fromName: null,
        subject: "Hi",
        snippet: "Hello",
        note: "test note",
      },
    ];
    const p = buildRefreshStylePayload(sync, newMail, {
      candidatesScanned: 5,
      llmDurationMs: 100,
    });
    expect(p.synced).toBe(2);
    expect(p.newMail).toHaveLength(1);
    expect(p.earlyExit).toBe(true);
    expect(p.candidatesScanned).toBe(5);
    expect(p.llmDurationMs).toBe(100);
    expect((p.newMail as typeof newMail)[0].note).toBe("test note");
  });

  it("text mode prints block layout with separators, not a column table", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    const sync: SyncResult = {
      synced: 1,
      messagesFetched: 1,
      bytesDownloaded: 0,
      durationMs: 100,
      bandwidthBytesPerSec: 0,
      messagesPerMinute: 0,
      logPath: "",
    };
    try {
      printRefreshStyleOutput(
        sync,
        [
          {
            messageId: "<id@x>",
            date: "2025-06-01T10:00:00.000Z",
            fromAddress: "a@b.com",
            fromName: "Alice",
            subject: "Hello there",
            snippet: "First line of body\nSecond line",
            note: "Worth reading",
          },
        ],
        { forceText: true, previewTitle: "New mail:", omitRefreshMetrics: true }
      );

      const out = lines.join("\n");
      expect(out).toContain("─".repeat(20));
      expect(out).toContain("Subject: Hello there");
      expect(out).toContain("Preview:");
      expect(out).toContain("First line of body");
      expect(out).toMatch(/Note:\s+Worth reading/);
      expect(out.indexOf("Note:")).toBeLessThan(out.indexOf("Preview:"));
      expect(out).not.toMatch(/DATE\s+FROM\s+SUBJECT\s+SNIPPET/);
    } finally {
      spy.mockRestore();
    }
  });
});

