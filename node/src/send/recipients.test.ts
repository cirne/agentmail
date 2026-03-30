import { describe, it, expect } from "vitest";
import { assertSendRecipientsAllowed, DEV_SEND_ALLOWLIST, extractEmailAddress } from "./recipients";

describe("extractEmailAddress", () => {
  it("extracts from angle brackets", () => {
    expect(extractEmailAddress("Bob <bob@example.com>")).toBe("bob@example.com");
  });

  it("returns bare address", () => {
    expect(extractEmailAddress("bob@example.com")).toBe("bob@example.com");
  });
});

describe("assertSendRecipientsAllowed", () => {
  it("allows any address when ZMAIL_SEND_TEST is unset", () => {
    expect(() =>
      assertSendRecipientsAllowed(["anyone@example.com"], { ZMAIL_SEND_TEST: undefined })
    ).not.toThrow();
  });

  it("allows only allowlist when ZMAIL_SEND_TEST is set", () => {
    expect(() =>
      assertSendRecipientsAllowed([`Name <${DEV_SEND_ALLOWLIST}>`], { ZMAIL_SEND_TEST: "1" })
    ).not.toThrow();
  });

  it("rejects other addresses when ZMAIL_SEND_TEST is set", () => {
    expect(() =>
      assertSendRecipientsAllowed(["other@example.com"], { ZMAIL_SEND_TEST: "1" })
    ).toThrow(/Send blocked/);
  });
});
