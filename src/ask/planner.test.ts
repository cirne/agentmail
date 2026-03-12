import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { runPlanner } from "./planner";

// Mock OpenAI
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

// Mock config
vi.mock("~/lib/config", async () => {
  const actual = await vi.importActual("~/lib/config");
  return {
    ...actual,
    config: {
      openai: {
        apiKey: "test-api-key",
      },
    },
  };
});

// Mock verbose logging
vi.mock("./verbose", () => ({
  verboseLog: vi.fn(),
}));

describe("runPlanner", () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("generates plan for person query", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              patterns: ["marcio", "nunes", "marcio nunes", "harmonee"],
              includeNoise: false,
            }),
          },
        },
      ],
    });

    const plan = await runPlanner("who is marcio nunes and how do I know him?");

    expect(plan.patterns).toEqual(["marcio", "nunes", "marcio nunes", "harmonee"]);
    expect(plan.includeNoise).toBe(false);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].model).toBe("gpt-4.1-nano");
    expect(mockCreate.mock.calls[0][0].response_format).toEqual({ type: "json_object" });
  });

  it("generates plan for domain spending query", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              patterns: ["apple", "receipt", "purchase", "order", "invoice"],
              fromAddress: "apple.com",
              afterDate: "30d",
              includeNoise: false,
            }),
          },
        },
      ],
    });

    const plan = await runPlanner("summarize my spending on apple.com in the last 30 days");

    expect(plan.patterns).toContain("apple");
    expect(plan.fromAddress).toBe("apple.com");
    expect(plan.afterDate).toBe("30d");
    expect(plan.includeNoise).toBe(false);
  });

  it("generates plan for news query with includeNoise", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              patterns: ["ai", "startup", "funding", "tech"],
              afterDate: "7d",
              includeNoise: true,
            }),
          },
        },
      ],
    });

    const plan = await runPlanner("what tech news did I get this week?");

    expect(plan.includeNoise).toBe(true);
    expect(plan.afterDate).toBe("7d");
  });

  it("generates plan for date range query", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              patterns: ["invoice"],
              afterDate: "2025-01-01",
              beforeDate: "2025-12-31",
              includeNoise: false,
            }),
          },
        },
      ],
    });

    const plan = await runPlanner("find invoices from 2025");

    expect(plan.afterDate).toBe("2025-01-01");
    expect(plan.beforeDate).toBe("2025-12-31");
  });

  it("falls back to basic plan on JSON parse error", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: "invalid json {",
          },
        },
      ],
    });

    const plan = await runPlanner("test question with keywords");

    expect(plan.patterns.length).toBeGreaterThan(0);
    expect(plan.includeNoise).toBe(false);
    // Fallback should extract words from question
    expect(plan.patterns.some((p) => p.includes("test") || p.includes("question"))).toBe(true);
  });

  it("falls back to basic plan on invalid plan structure", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              // Missing patterns array
              includeNoise: false,
            }),
          },
        },
      ],
    });

    const plan = await runPlanner("test question");

    expect(plan.patterns.length).toBeGreaterThan(0);
    expect(plan.includeNoise).toBe(false);
  });

  it("falls back to basic plan on API error", async () => {
    mockCreate.mockRejectedValueOnce(new Error("API error"));

    const plan = await runPlanner("test question");

    expect(plan.patterns.length).toBeGreaterThan(0);
    expect(plan.includeNoise).toBe(false);
  });

  it("normalizes includeNoise to boolean if missing", async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              patterns: ["test"],
              // includeNoise missing
            }),
          },
        },
      ],
    });

    const plan = await runPlanner("test");

    expect(plan.includeNoise).toBe(false);
  });
});
