import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    // Exclude eval tests from default test run
    // Eval tests are run separately via `npm run eval`
    exclude: ["**/*.eval.test.ts", "**/node_modules/**"],
  },
  resolve: {
    alias: {
      "~": resolve(__dirname, "./src"),
    },
  },
});
