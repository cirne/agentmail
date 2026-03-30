import { defineConfig } from "vitest/config";
import { resolve } from "path";

/**
 * Separate config for eval tests.
 * Eval tests are conceptually different from unit tests:
 * - They test LLM behavior and require OpenAI API access
 * - They're bound by API latency, so need high parallelism
 * - They're run separately via `npm run eval`
 */
export default defineConfig({
  test: {
    globals: true,
    // Only include eval test files
    include: ["**/*.eval.test.ts"],
    // High parallelism for eval tests (bound by OpenAI API latency)
    pool: "threads",
    poolOptions: {
      threads: {
        // High concurrency for I/O-bound tests (API calls)
        maxThreads: 10,
        minThreads: 1,
      },
    },
    // Run tests concurrently within test files
    sequence: {
      concurrent: true,
    },
    // Allow unlimited concurrent tests (for eval suite bound by API latency)
    maxConcurrency: 100,
    // Run test files in parallel
    fileParallelism: true,
    // Increase timeout for eval tests with API calls
    testTimeout: 60000,
  },
  resolve: {
    alias: {
      "~": resolve(__dirname, "./src"),
    },
  },
});
