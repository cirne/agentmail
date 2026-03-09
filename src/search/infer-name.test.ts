import { describe, it, expect } from "vitest";
import { inferNameFromAddress } from "./infer-name";

describe("inferNameFromAddress", () => {
  it("infers name from dot-separated local-part", () => {
    expect(inferNameFromAddress("lewis.cirne@alum.dartmouth.org")).toBe("Lewis Cirne");
    expect(inferNameFromAddress("katelyn.cirne@gmail.com")).toBe("Katelyn Cirne");
    expect(inferNameFromAddress("alan.finley@example.com")).toBe("Alan Finley");
  });

  it("infers name from underscore-separated local-part", () => {
    expect(inferNameFromAddress("katelyn_cirne@icloud.com")).toBe("Katelyn Cirne");
    expect(inferNameFromAddress("john_smith@example.com")).toBe("John Smith");
  });

  it("infers name from camelCase local-part", () => {
    expect(inferNameFromAddress("lewisCirne@example.com")).toBe("Lewis Cirne");
    expect(inferNameFromAddress("johnSmith@example.com")).toBe("John Smith");
  });

  it("infers name from all-lowercase local-part when pattern is clear", () => {
    // Improved heuristics should handle common patterns
    expect(inferNameFromAddress("alanfinley@example.com")).toBe("Alan Finley");
    expect(inferNameFromAddress("johnsmith@example.com")).toBe("John Smith");
    expect(inferNameFromAddress("whitneyallen@example.com")).toBe("Whitney Allen");
  });

  it("infers name from single-letter prefix pattern", () => {
    expect(inferNameFromAddress("abrown@somecompany.com")).toBe("A Brown");
    expect(inferNameFromAddress("jsmith@example.com")).toBe("J Smith");
    // Ambiguous short cases should still return null
    expect(inferNameFromAddress("sjohnson@example.com")).toBeNull(); // Too short last name (4 chars)
  });

  it("returns null for non-name patterns", () => {
    expect(inferNameFromAddress("recipient@example.com")).toBeNull();
    expect(inferNameFromAddress("noreply@example.com")).toBeNull();
    expect(inferNameFromAddress("support@example.com")).toBeNull();
    expect(inferNameFromAddress("admin@example.com")).toBeNull();
  });

  it("returns null for invalid or unclear patterns", () => {
    expect(inferNameFromAddress("ab@example.com")).toBeNull(); // Too short
    expect(inferNameFromAddress("a@example.com")).toBeNull(); // Too short
    expect(inferNameFromAddress("123@example.com")).toBeNull(); // Numbers
  });

  it("returns null for ambiguous all-lowercase patterns that could be usernames", () => {
    expect(inferNameFromAddress("fredbrown@example.com")).toBeNull(); // No strong signal, could be username
  });
});
