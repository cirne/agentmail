import { describe, it, expect } from "vitest";
import {
  computeFetchAllTimeoutMs,
  FETCH_ALL_TIMEOUT_MAX_MS,
  FETCH_ALL_TIMEOUT_MIN_MS,
  isFetchAllTimeoutMessage,
  timeoutMsForFetchAllAttempt,
} from "./fetch-all-timeout";

/**
 * Pure timeout math + string matching only — no setTimeout, no fake timers needed.
 * Timeout/retry integration is covered in fetch-all-with-retries.test.ts with fake timers (no 60s+ waits).
 */
describe("fetch-all-timeout", () => {
  it("scales with batch size and respects floor/ceiling", () => {
    expect(computeFetchAllTimeoutMs(1)).toBe(FETCH_ALL_TIMEOUT_MIN_MS);
    expect(computeFetchAllTimeoutMs(300)).toBe(
      Math.min(FETCH_ALL_TIMEOUT_MAX_MS, 30_000 + 300 * 300)
    );
    expect(computeFetchAllTimeoutMs(10_000)).toBe(FETCH_ALL_TIMEOUT_MAX_MS);
  });

  it("retry attempt uses 1.5x base capped by max", () => {
    const base = computeFetchAllTimeoutMs(300);
    expect(timeoutMsForFetchAllAttempt(300, 1)).toBe(base);
    expect(timeoutMsForFetchAllAttempt(300, 2)).toBe(
      Math.min(FETCH_ALL_TIMEOUT_MAX_MS, Math.floor(base * 1.5))
    );
  });

  it("detects fetchAll timeout errors", () => {
    expect(isFetchAllTimeoutMessage("fetchAll timed out after 30s")).toBe(true);
    expect(isFetchAllTimeoutMessage("connection reset")).toBe(false);
  });
});
