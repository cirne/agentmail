import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeMessageMeta, readMessageMeta, metaPathForEml } from "./message-meta";

describe("message-meta sidecar", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zmail-meta-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("metaPathForEml", () => {
    it("replaces .eml with .meta.json", () => {
      expect(metaPathForEml("/path/to/100_msg.eml")).toBe("/path/to/100_msg.meta.json");
    });
  });

  describe("writeMessageMeta", () => {
    it("writes sidecar with labels", () => {
      const emlPath = join(tempDir, "100_test.eml");
      writeFileSync(emlPath, "dummy");

      writeMessageMeta(emlPath, { labels: ["\\Inbox", "Promotions"] });

      const metaPath = metaPathForEml(emlPath);
      expect(existsSync(metaPath)).toBe(true);
    });

    it("skips writing when labels are empty", () => {
      const emlPath = join(tempDir, "100_test.eml");
      writeFileSync(emlPath, "dummy");

      writeMessageMeta(emlPath, { labels: [] });

      const metaPath = metaPathForEml(emlPath);
      expect(existsSync(metaPath)).toBe(false);
    });

    it("skips writing when no labels field", () => {
      const emlPath = join(tempDir, "100_test.eml");
      writeFileSync(emlPath, "dummy");

      writeMessageMeta(emlPath, {});

      const metaPath = metaPathForEml(emlPath);
      expect(existsSync(metaPath)).toBe(false);
    });
  });

  describe("readMessageMeta", () => {
    it("reads labels from sidecar", () => {
      const emlPath = join(tempDir, "100_test.eml");
      writeFileSync(emlPath, "dummy");
      writeMessageMeta(emlPath, { labels: ["\\Inbox", "Promotions"] });

      const meta = readMessageMeta(emlPath);
      expect(meta.labels).toEqual(["\\Inbox", "Promotions"]);
    });

    it("returns empty object when no sidecar exists", () => {
      const emlPath = join(tempDir, "100_test.eml");
      const meta = readMessageMeta(emlPath);
      expect(meta).toEqual({});
    });

    it("returns empty object for malformed JSON", () => {
      const emlPath = join(tempDir, "100_test.eml");
      const metaPath = metaPathForEml(emlPath);
      writeFileSync(metaPath, "not json");

      const meta = readMessageMeta(emlPath);
      expect(meta).toEqual({});
    });

    it("preserves extra fields for future extensibility", () => {
      const emlPath = join(tempDir, "100_test.eml");
      const metaPath = metaPathForEml(emlPath);
      writeFileSync(metaPath, JSON.stringify({ labels: ["\\Inbox"], someNewField: 42 }));

      const meta = readMessageMeta(emlPath);
      expect(meta.labels).toEqual(["\\Inbox"]);
      expect((meta as any).someNewField).toBe(42);
    });
  });
});
