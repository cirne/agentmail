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
  it("allows only allowlist when production off", () => {
    expect(() =>
      assertSendRecipientsAllowed([`Name <${DEV_SEND_ALLOWLIST}>`], { ZMAIL_SEND_PRODUCTION: undefined })
    ).not.toThrow();
  });

  it("rejects other addresses when production off", () => {
    expect(() =>
      assertSendRecipientsAllowed(["other@example.com"], { ZMAIL_SEND_PRODUCTION: undefined })
    ).toThrow(/Send blocked/);
  });

  it("allows any address when ZMAIL_SEND_PRODUCTION=1", () => {
    expect(() =>
      assertSendRecipientsAllowed(["anyone@example.com"], { ZMAIL_SEND_PRODUCTION: "1" })
    ).not.toThrow();
  });
});
