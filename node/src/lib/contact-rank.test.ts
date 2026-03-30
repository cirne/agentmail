import { describe, it, expect } from "vitest";
import { computeContactRank, CONTACT_RANK_LOG_CAP } from "./contact-rank";

describe("computeContactRank", () => {
  it("returns 0 for all zeros", () => {
    expect(
      computeContactRank({
        sentCount: 0,
        repliedCount: 0,
        receivedCount: 0,
        mentionedCount: 0,
      })
    ).toBe(0);
  });

  it("increases monotonically with sent when others fixed", () => {
    const a = computeContactRank({
      sentCount: 1,
      repliedCount: 0,
      receivedCount: 0,
      mentionedCount: 0,
    });
    const b = computeContactRank({
      sentCount: 10,
      repliedCount: 0,
      receivedCount: 0,
      mentionedCount: 0,
    });
    expect(b).toBeGreaterThan(a);
  });

  it("caps extreme counts via log (finite growth)", () => {
    const huge = computeContactRank({
      sentCount: 1e9,
      repliedCount: 1e9,
      receivedCount: 1e9,
      mentionedCount: 1e9,
    });
    expect(Number.isFinite(huge)).toBe(true);
    expect(huge).toBeLessThan(CONTACT_RANK_LOG_CAP * 10);
  });

  it("dampens one-way inbound firehoses (newsletters) vs bilateral mail", () => {
    const newsletter = computeContactRank({
      sentCount: 0,
      repliedCount: 0,
      receivedCount: 810,
      mentionedCount: 0,
    });
    const coworker = computeContactRank({
      sentCount: 50,
      repliedCount: 20,
      receivedCount: 80,
      mentionedCount: 0,
    });
    expect(coworker).toBeGreaterThan(newsletter);
  });

  it("still gives some weight to a few one-way messages (not zero relationship)", () => {
    const none = computeContactRank({
      sentCount: 0,
      repliedCount: 0,
      receivedCount: 0,
      mentionedCount: 0,
    });
    const few = computeContactRank({
      sentCount: 0,
      repliedCount: 0,
      receivedCount: 5,
      mentionedCount: 0,
    });
    expect(few).toBeGreaterThan(none);
  });

  it("raises rank when outbound grows for the same high received (ratio improves)", () => {
    const highInbound = 400;
    const noOutbound = computeContactRank({
      sentCount: 0,
      repliedCount: 0,
      receivedCount: highInbound,
      mentionedCount: 0,
    });
    const someOutbound = computeContactRank({
      sentCount: 30,
      repliedCount: 0,
      receivedCount: highInbound,
      mentionedCount: 0,
    });
    expect(someOutbound).toBeGreaterThan(noOutbound);
  });
});
