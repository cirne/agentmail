import { describe, it, expect } from "vitest";
import { MCP_CREATE_DRAFT_PARAM_KEYS, MCP_SEND_DRAFT_PARAM_KEYS } from "./index";

describe("MCP draft tool schemas", () => {
  it("exposes stable param keys for send_draft and create_draft", () => {
    expect(MCP_SEND_DRAFT_PARAM_KEYS).toEqual(expect.arrayContaining(["draftId", "dryRun"]));
    expect(MCP_CREATE_DRAFT_PARAM_KEYS).toEqual(
      expect.arrayContaining(["kind", "to", "subject", "body", "sourceMessageId", "forwardOf"])
    );
  });
});
