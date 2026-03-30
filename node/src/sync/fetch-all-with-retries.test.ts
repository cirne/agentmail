import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { timeoutMsForFetchAllAttempt } from "./fetch-all-timeout";
import { fetchAllWithTimeoutAndRetries } from "./fetch-all-with-retries";

/** Minimal logger stand-in — real sync uses FileLogger. */
function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), writeSeparator: vi.fn(), close: vi.fn() };
}

describe("fetchAllWithTimeoutAndRetries", () => {
  it("resolves when fetchAll completes immediately (no timer wait)", async () => {
    const client = {
      fetchAll: vi.fn().mockResolvedValue([{ uid: 1 }]),
    };
    const fileLogger = mockLogger();
    const result = await fetchAllWithTimeoutAndRetries(
      client as never,
      [1],
      1,
      1,
      fileLogger as never
    );
    expect(result).toEqual([{ uid: 1 }]);
    expect(client.fetchAll).toHaveBeenCalledTimes(1);
  });

  it("throws on non-timeout errors without sleeping", async () => {
    const client = {
      fetchAll: vi.fn().mockRejectedValue(new Error("connection reset")),
    };
    const fileLogger = mockLogger();
    await expect(
      fetchAllWithTimeoutAndRetries(client as never, [1], 1, 1, fileLogger as never)
    ).rejects.toThrow("connection reset");
    expect(client.fetchAll).toHaveBeenCalledTimes(1);
  });

  describe("fake timers — timeout/retry logic (no wall-clock delay)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("fires retry warn then fails after second timeout using only advanced fake time", async () => {
      const client = {
        fetchAll: vi.fn().mockImplementation(() => new Promise<never>(() => {})),
      };
      const fileLogger = mockLogger();
      const batch = [1];
      const t1 = timeoutMsForFetchAllAttempt(batch.length, 1);
      const t2 = timeoutMsForFetchAllAttempt(batch.length, 2);

      const p = fetchAllWithTimeoutAndRetries(client as never, batch, 1, 1, fileLogger as never);
      // Register rejection handler before advancing timers (avoids unhandled rejection with fake timers).
      const assertRejected = expect(p).rejects.toThrow(/fetchAll timed out/);

      await vi.advanceTimersByTimeAsync(t1);
      await vi.advanceTimersByTimeAsync(t2);
      await assertRejected;
      expect(client.fetchAll).toHaveBeenCalledTimes(2);
      expect(fileLogger.warn).toHaveBeenCalledWith(
        "fetchAll timed out; retrying same batch with longer limit",
        expect.objectContaining({ nextAttempt: 2 })
      );
      expect(fileLogger.error).toHaveBeenCalledWith(
        "fetchAll timed out on all attempts; aborting sync run",
        expect.any(Object)
      );
    });

    it("succeeds on second attempt when first times out and second fetch resolves (fake time only)", async () => {
      const client = {
        fetchAll: vi
          .fn()
          .mockImplementationOnce(() => new Promise<never>(() => {}))
          .mockResolvedValueOnce([{ uid: 42 }]),
      };
      const fileLogger = mockLogger();
      const batch = [1];
      const t1 = timeoutMsForFetchAllAttempt(batch.length, 1);

      const p = fetchAllWithTimeoutAndRetries(client as never, batch, 1, 1, fileLogger as never);

      await vi.advanceTimersByTimeAsync(t1);
      const result = await p;

      expect(result).toEqual([{ uid: 42 }]);
      expect(client.fetchAll).toHaveBeenCalledTimes(2);
      expect(fileLogger.info).toHaveBeenCalledWith(
        "fetchAll completed after retry",
        expect.objectContaining({ attempt: 2 })
      );
    });
  });
});
