import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { SqliteDatabase } from "~/db";
import { createTestDb } from "~/db/test-helpers";
import { runAsk } from "./agent";

// Mock OpenAI - create a mock instance
const mockCreate = vi.fn();
const mockOpenAIInstance = {
  chat: {
    completions: {
      create: mockCreate,
    },
  },
};

vi.mock("openai", () => {
  return {
    default: vi.fn().mockImplementation(() => mockOpenAIInstance),
  };
});

// Mock config - need to provide all exports
vi.mock("~/lib/config", async () => {
  const actual = await vi.importActual("~/lib/config");
  return {
    ...actual,
    config: {
      openai: {
        apiKey: "test-api-key",
      },
      imap: {
        user: "test@example.com",
      },
      maildirPath: "/tmp/test-maildir",
    },
  };
});

// Mock message presenter
vi.mock("~/messages/presenter", () => ({
  formatMessageForOutput: vi.fn().mockImplementation(async (msg: any) => ({
    message_id: msg.message_id,
    subject: msg.subject,
    from_address: msg.from_address,
    from_name: msg.from_name,
    date: msg.date,
    content: {
      markdown: msg.body_text || "",
    },
  })),
}));

// Mock lean shape
vi.mock("~/messages/lean-shape", () => ({
  toLeanMessage: vi.fn().mockImplementation((msg: any) => ({
    from_address: msg.from_address,
    from_name: msg.from_name,
    subject: msg.subject,
    date: msg.date,
    content: {
      markdown: msg.content?.markdown || "",
    },
  })),
  DEFAULT_BODY_CAP: 2000,
}));

// Mock planner
vi.mock("./planner", () => ({
  runPlanner: vi.fn().mockResolvedValue({
    patterns: ["test"],
    includeNoise: false,
  }),
}));

// Mock scatter
vi.mock("./scatter", () => ({
  scatter: vi.fn().mockResolvedValue([]),
}));

// Mock assemble
vi.mock("./assemble", () => ({
  assembleContext: vi.fn().mockResolvedValue("---\nFrom: test@example.com\nSubject: Test\nDate: 2025-01-01\nTest content"),
}));

// Mock verbose
vi.mock("./verbose", () => ({
  setVerbose: vi.fn(),
  verboseLog: vi.fn(),
}));

describe("runAsk", () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = createTestDb();
    mockCreate.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("runs full pipeline: planner → scatter → assemble → synthesize", async () => {
    // Mock Mini synthesis response
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: "Test answer",
          },
        },
      ],
    });

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const answer = await runAsk("test question", db, { stream: false });

    // Should call Nano once for synthesis
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].model).toBe("gpt-4.1-nano");
    expect(answer).toBe("Test answer");

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("streams answer when stream=true", async () => {
    // Mock streaming response
    const streamChunks = [
      { choices: [{ delta: { content: "Test " } }] },
      { choices: [{ delta: { content: "answer" } }] },
    ];

    mockCreate.mockResolvedValueOnce({
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of streamChunks) {
          yield chunk;
        }
      },
    });

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runAsk("test question", db, { stream: true });

    // Should call Nano with stream: true
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].stream).toBe(true);
    expect(mockCreate.mock.calls[0][0].model).toBe("gpt-4.1-nano");

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("includes question and context in synthesis prompt", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: "Answer",
          },
        },
      ],
    });

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runAsk("what is this?", db, { stream: false });

    const messages = mockCreate.mock.calls[0][0].messages;
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("what is this?");
    expect(messages[1].content).toContain("--- Email Context ---");

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("handles empty context gracefully", async () => {
    // Mock assemble to return empty context
    const { assembleContext } = await import("./assemble");
    vi.mocked(assembleContext).mockResolvedValueOnce("");

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: "I couldn't find any relevant emails.",
          },
        },
      ],
    });

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const answer = await runAsk("test question", db, { stream: false });

    expect(answer).toBe("I couldn't find any relevant emails.");

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});
