import { describe, it, expect, beforeAll } from "vitest";
import type { SqliteDatabase } from "~/db";
import { createTestDb, insertTestMessage } from "~/db/test-helpers";
import { runAsk } from "./agent";
import OpenAI from "openai";
import { config } from "~/lib/config";

/**
 * Helper to run ask and capture the answer as a string.
 * When stream=false, runAsk uses console.log for the answer.
 * We capture only the answer, not our eval logging.
 */
async function runAskAndCapture(
  question: string,
  db: SqliteDatabase,
  opts?: { stream?: boolean }
): Promise<{ answer: string; latencyMs: number }> {
  const startTime = Date.now();
  const capturedLogs: string[] = [];
  let captureCount = 0;

  // Intercept console.log to capture the answer
  // runAsk calls console.log once with the answer when stream=false
  const originalLog = console.log;
  console.log = (...args: any[]) => {
    const text = args.map((a) => String(a)).join(" ");
    // Capture all console.log calls during runAsk execution
    // Filter out eval logging markers
    if (!text.startsWith("[Eval]") && !text.includes("[Eval]")) {
      capturedLogs.push(text);
      captureCount++;
    }
    // Still call original to see output during tests
    originalLog(...args);
  };

  try {
    await runAsk(question, db, { ...opts, stream: false });
  } finally {
    console.log = originalLog;
  }

  // The answer should be the last non-empty console.log call from runAsk
  // Filter out empty lines and get the actual answer
  const answer = capturedLogs
    .filter((line) => line.trim().length > 0 && !line.startsWith("[Eval]"))
    .slice(-1)[0] || capturedLogs.join("\n").trim();

  const latencyMs = Date.now() - startTime;
  return { answer, latencyMs };
}

/**
 * LLM-as-a-judge: Evaluate answer quality using GPT-4.
 * Returns a score from 0-1 and reasoning.
 */
async function evaluateAnswerWithLLM(
  question: string,
  answer: string,
  criteria: {
    mustInclude?: string[]; // Keywords/concepts that must appear
    mustNotInclude?: string[]; // Keywords/concepts that should not appear
    minLength?: number; // Minimum answer length
    maxLength?: number; // Maximum answer length
    expectedTopics?: string[]; // Topics that should be covered
  }
): Promise<{ score: number; reasoning: string; passed: boolean }> {
  const client = new OpenAI({ apiKey: config.openai.apiKey });

  const criteriaText = [
    criteria.mustInclude?.length ? `Must include: ${criteria.mustInclude.join(", ")}` : null,
    criteria.mustNotInclude?.length ? `Must NOT include: ${criteria.mustNotInclude.join(", ")}` : null,
    criteria.minLength ? `Minimum length: ${criteria.minLength} characters` : null,
    criteria.maxLength ? `Maximum length: ${criteria.maxLength} characters` : null,
    criteria.expectedTopics?.length ? `Should cover topics: ${criteria.expectedTopics.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = `You are evaluating an answer to a question about email. Rate the answer quality on a scale of 0.0 to 1.0.

Question: ${question}

Answer: ${answer}

Evaluation Criteria:
${criteriaText || "Answer should be accurate, relevant, and complete."}

Consider:
- Accuracy: Does the answer correctly address the question?
- Completeness: Does it include all relevant information?
- Relevance: Is the information directly related to the question?
- Clarity: Is the answer clear and well-structured?

Respond with a JSON object:
{
  "score": 0.0-1.0,
  "reasoning": "Brief explanation of the score",
  "passed": true/false (true if score >= 0.7)
}`;

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini", // Use mini for cost efficiency
    messages: [
      {
        role: "system",
        content: "You are an evaluation judge. Always respond with valid JSON only.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: 0.3, // Lower temperature for more consistent evaluation
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("No response from LLM judge");
  }

  try {
    const result = JSON.parse(content);
    return {
      score: result.score ?? 0,
      reasoning: result.reasoning ?? "No reasoning provided",
      passed: result.passed ?? false,
    };
  } catch (e) {
    // Fallback: try to extract score from text
    const scoreMatch = content.match(/"score"\s*:\s*([\d.]+)/);
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
    return {
      score,
      reasoning: content,
      passed: score >= 0.7,
    };
  }
}

/**
 * Evaluation test case definition.
 */
interface EvalCase {
  question: string;
  description?: string;
  setup?: (db: SqliteDatabase) => void | Promise<void>; // Setup test data
  criteria: {
    mustInclude?: string[];
    mustNotInclude?: string[];
    minLength?: number;
    maxLength?: number;
    expectedTopics?: string[];
  };
  maxLatencyMs?: number; // Maximum acceptable latency
  minScore?: number; // Minimum LLM judge score (default: 0.7)
}

/**
 * Evaluation test cases for zmail ask.
 * Add new cases here to expand the eval suite.
 */
const EVAL_CASES: EvalCase[] = [
  {
    question: "who is marcio nunes and how do I know him?",
    description: "Person lookup with relationship context",
    setup: (db) => {
      insertTestMessage(db, {
        messageId: "<msg1@example.com>",
        subject: "Introduction",
        fromAddress: "marcio@vergemktg.com",
        fromName: "Marcio Nunes",
        bodyText: "Hi, I'm Marcio Nunes, CEO & Founder of Harmonee AI. We met at the conference last month.",
        date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days ago
      });
      insertTestMessage(db, {
        messageId: "<msg2@example.com>",
        subject: "Follow up",
        fromAddress: "marcio@vergemktg.com",
        fromName: "Marcio Nunes",
        bodyText: "Thanks for the great conversation! Looking forward to collaborating.",
        date: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
      });
    },
    criteria: {
      mustInclude: ["marcio", "nunes"],
      expectedTopics: ["CEO", "Founder", "Harmonee AI", "conference", "met"],
      minLength: 50,
    },
    maxLatencyMs: 20000,
  },
  {
    question: "what emails did I get today?",
    description: "Recent emails query",
    setup: (db) => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      insertTestMessage(db, {
        messageId: "<today1@example.com>",
        subject: "Morning update",
        fromAddress: "alice@example.com",
        bodyText: "Here's your daily update",
        date: new Date(today.getTime() + 8 * 60 * 60 * 1000).toISOString(), // 8am today
      });
      insertTestMessage(db, {
        messageId: "<today2@example.com>",
        subject: "Afternoon meeting",
        fromAddress: "bob@example.com",
        bodyText: "Reminder about our 3pm meeting",
        date: new Date(today.getTime() + 14 * 60 * 60 * 1000).toISOString(), // 2pm today
      });
    },
    criteria: {
      expectedTopics: ["today", "email"],
      minLength: 30,
    },
    maxLatencyMs: 15000,
  },
  {
    question: "summarize my spending on apple.com in the last 30 days",
    description: "Spending summary with date filter",
    setup: (db) => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      insertTestMessage(db, {
        messageId: "<apple1@example.com>",
        subject: "Your Apple Store receipt",
        fromAddress: "noreply@apple.com",
        bodyText: "Thank you for your purchase. Total: $99.00",
        date: new Date(thirtyDaysAgo.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString(), // 25 days ago
      });
      insertTestMessage(db, {
        messageId: "<apple2@example.com>",
        subject: "Your Apple Store receipt",
        fromAddress: "noreply@apple.com",
        bodyText: "Thank you for your purchase. Total: $149.00",
        date: new Date(thirtyDaysAgo.getTime() + 10 * 24 * 60 * 60 * 1000).toISOString(), // 20 days ago
      });
    },
    criteria: {
      mustInclude: ["apple"],
      expectedTopics: ["spending", "purchase", "receipt", "total"],
      minLength: 40,
    },
    maxLatencyMs: 20000,
  },
  {
    question: "What are the 5 most recent messages in my inbox?",
    description: "Recent messages listing with count",
    setup: (db) => {
      const subjects = [
        "Weekly Newsletter",
        "Project Update",
        "Meeting Tomorrow",
        "Invoice #99001",
        "Lunch Plans",
        "Older Message",
      ];
      subjects.forEach((subject, i) => {
        insertTestMessage(db, {
          messageId: `<recent${i}@example.com>`,
          subject,
          fromAddress: `sender${i}@example.com`,
          bodyText: `Body of email: ${subject}`,
          date: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString(),
        });
      });
    },
    criteria: {
      expectedTopics: ["Weekly Newsletter", "Project Update", "Meeting Tomorrow", "Invoice", "Lunch Plans"],
      minLength: 50,
    },
    maxLatencyMs: 20000,
  },
  {
    question: "find any emails about invoices",
    description: "Broad search without date filter",
    setup: (db) => {
      // Add old invoice
      insertTestMessage(db, {
        messageId: "<invoice-old@example.com>",
        subject: "Invoice #12345",
        fromAddress: "billing@example.com",
        bodyText: "Please find attached invoice for services rendered.",
        date: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(), // 200 days ago
      });
      // Add recent invoice
      insertTestMessage(db, {
        messageId: "<invoice-recent@example.com>",
        subject: "Invoice #67890",
        fromAddress: "billing@example.com",
        bodyText: "Please find attached invoice for services rendered.",
        date: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(), // 5 days ago
      });
    },
    criteria: {
      mustInclude: ["invoice"],
      expectedTopics: ["invoice"],
      minLength: 30,
    },
    maxLatencyMs: 20000,
  },
];

describe("zmail ask evaluation suite", () => {
  let db: SqliteDatabase;

  // Setup database once for all tests (readonly tests share the same DB)
  beforeAll(async () => {
    db = createTestDb();
    // Populate database with all test data upfront
    for (const testCase of EVAL_CASES) {
      if (testCase.setup) {
        await testCase.setup(db);
      }
    }
  });

  // Skip if OpenAI API key is not configured
  const hasOpenAIKey = (() => {
    try {
      return config.openai.apiKey.length > 0;
    } catch {
      return false;
    }
  })();

  if (!hasOpenAIKey) {
    it.skip("requires ZMAIL_OPENAI_API_KEY to be set", () => {
      // Skip all tests if API key is missing
    });
  }

  for (const testCase of EVAL_CASES) {
    it.concurrent(
      `should answer: "${testCase.question}"${testCase.description ? ` (${testCase.description})` : ""}`,
      async () => {
        if (!hasOpenAIKey) {
          return; // Skip if no API key
        }

        // Test data already set up in beforeAll

        // Run ask and capture answer
        const { answer, latencyMs } = await runAskAndCapture(testCase.question, db, { stream: false });

        // Check latency
        if (testCase.maxLatencyMs) {
          expect(latencyMs).toBeLessThan(testCase.maxLatencyMs);
        }

        // Check basic requirements
        if (testCase.criteria.minLength) {
          expect(answer.length).toBeGreaterThanOrEqual(testCase.criteria.minLength);
        }
        if (testCase.criteria.maxLength) {
          expect(answer.length).toBeLessThanOrEqual(testCase.criteria.maxLength);
        }

        // Use LLM-as-a-judge to evaluate answer quality
        const evaluation = await evaluateAnswerWithLLM(testCase.question, answer, testCase.criteria);
        const minScore = testCase.minScore ?? 0.7;

        // Log evaluation details for debugging
        console.log(`\n[Eval] Question: ${testCase.question}`);
        console.log(`[Eval] Answer length: ${answer.length} chars`);
        console.log(`[Eval] Latency: ${latencyMs}ms`);
        console.log(`[Eval] LLM Score: ${evaluation.score.toFixed(2)}/1.0`);
        console.log(`[Eval] Reasoning: ${evaluation.reasoning}`);
        console.log(`[Eval] Answer: ${answer.substring(0, 200)}${answer.length > 200 ? "..." : ""}`);

        // Assert minimum score
        expect(evaluation.score).toBeGreaterThanOrEqual(minScore);
        expect(evaluation.passed).toBe(true);
      },
      30000 // 30 second timeout for LLM calls
    );
  }

  describe("performance benchmarks", () => {
    beforeAll(async () => {
      // Setup benchmark test data (readonly, so safe to share)
      insertTestMessage(db, {
        messageId: "<simple@example.com>",
        subject: "Test",
        bodyText: "Test content",
      });
    });

    it.concurrent(
      "should complete simple queries in reasonable time",
      async () => {
        if (!hasOpenAIKey) {
          return;
        }

        // Test data already set up in beforeAll
        const { latencyMs } = await runAskAndCapture("what is this email about?", db, { stream: false });

        // Simple queries should complete quickly
        expect(latencyMs).toBeLessThan(15000);
        console.log(`\n[Benchmark] Simple query latency: ${latencyMs}ms`);
      },
      30000 // 30 second timeout
    );
  });
});
