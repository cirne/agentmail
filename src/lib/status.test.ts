import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatTimeAgo } from "./status";

describe("formatTimeAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null for null input", () => {
    expect(formatTimeAgo(null)).toBeNull();
  });

  it("returns 'just now' for dates within the last minute", () => {
    const result = formatTimeAgo("2026-03-07T11:59:30Z");
    expect(result).toEqual({ human: "just now", duration: "PT0S" });
  });

  it("formats minutes ago", () => {
    const result = formatTimeAgo("2026-03-07T11:55:00Z");
    expect(result).toEqual({ human: "5m ago", duration: "PT5M" });
  });

  it("formats hours ago", () => {
    const result = formatTimeAgo("2026-03-07T10:00:00Z");
    expect(result).toEqual({ human: "2h ago", duration: "PT2H" });
  });

  it("formats days ago", () => {
    const result = formatTimeAgo("2026-03-05T12:00:00Z");
    expect(result).toEqual({ human: "2d ago", duration: "P2D" });
  });

  it("formats weeks ago", () => {
    const result = formatTimeAgo("2026-02-28T12:00:00Z");
    expect(result).toEqual({ human: "1w ago", duration: "P1W" });
  });

  it("formats months ago", () => {
    const result = formatTimeAgo("2025-12-07T12:00:00Z"); // ~3 months ago
    expect(result).toEqual({ human: "3mo ago", duration: "P90D" });
  });

  it("formats years ago", () => {
    const result = formatTimeAgo("2024-03-07T12:00:00Z");
    expect(result).toEqual({ human: "2y ago", duration: "P2Y" });
  });

  it("handles SQLite datetime format (no Z)", () => {
    const result = formatTimeAgo("2026-03-07 11:55:00");
    expect(result).toEqual({ human: "5m ago", duration: "PT5M" });
  });

  it("returns null for future dates", () => {
    expect(formatTimeAgo("2026-03-08T12:00:00Z")).toBeNull();
  });
});
