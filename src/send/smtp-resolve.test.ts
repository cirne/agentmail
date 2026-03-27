import { describe, it, expect } from "vitest";
import { resolveSmtpSettings } from "./smtp-resolve";

describe("resolveSmtpSettings", () => {
  it("maps imap.gmail.com to smtp.gmail.com:587 STARTTLS", () => {
    expect(resolveSmtpSettings("imap.gmail.com")).toEqual({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
    });
  });

  it("uses imap.* → smtp.* heuristic for unknown domains", () => {
    expect(resolveSmtpSettings("imap.example.com")).toEqual({
      host: "smtp.example.com",
      port: 587,
      secure: false,
    });
  });

  it("merges explicit overrides", () => {
    expect(resolveSmtpSettings("imap.gmail.com", { port: 465, secure: true })).toEqual({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
    });
  });

  it("throws when host is not inferable and overrides incomplete", () => {
    expect(() => resolveSmtpSettings("mail.example.com", {})).toThrow(/Cannot infer SMTP/);
  });

  it("allows explicit smtp for non-inferable host", () => {
    expect(
      resolveSmtpSettings("mail.example.com", {
        host: "smtp.outlook.com",
        port: 587,
        secure: false,
      })
    ).toEqual({
      host: "smtp.outlook.com",
      port: 587,
      secure: false,
    });
  });
});
