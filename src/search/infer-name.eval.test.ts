import { describe, it, expect } from "vitest";
import { inferNameFromAddress } from "./infer-name";
import { NAME_INFERENCE_FIXTURE, type NameInferenceTestCase } from "./infer-name.fixture";

describe("Name Inference Evaluation", () => {
  /**
   * Evaluation test that measures inference accuracy across a large fixture
   * of real email addresses from the zmail database.
   * 
   * This is similar to an eval: we want to measure how many addresses
   * resolve to their expected names, and ensure we don't fail at <100% success.
   */
  it("should infer names correctly for fixture test cases", () => {
    if (NAME_INFERENCE_FIXTURE.length === 0) {
      console.warn("Fixture is empty. Run: npx tsx scripts/extract-name-fixture.ts");
      return;
    }

    const results: Array<{
      testCase: NameInferenceTestCase;
      actual: string | null;
      passed: boolean;
    }> = [];

    for (const testCase of NAME_INFERENCE_FIXTURE) {
      const actual = inferNameFromAddress(testCase.address);
      const passed = actual === testCase.expectedName;
      
      results.push({
        testCase,
        actual,
        passed,
      });
    }

    // Calculate metrics
    const total = results.length;
    const passed = results.filter((r) => r.passed).length;
    const successRate = (passed / total) * 100;

    // Log failures for debugging
    const failures = results.filter((r) => !r.passed);
    if (failures.length > 0) {
      console.log(`\nFailures (${failures.length}):`);
      for (const failure of failures.slice(0, 20)) {
        // Show first 20 failures
        console.log(
          `  ${failure.testCase.address} => expected "${failure.testCase.expectedName}", got "${failure.actual}"`
        );
      }
      if (failures.length > 20) {
        console.log(`  ... and ${failures.length - 20} more`);
      }
    }

    // Assert high success rate (should be close to 100%)
    // Allow some tolerance for edge cases, but expect >95% success
    expect(successRate).toBeGreaterThan(95);
    expect(passed).toBe(total);
  });

  /**
   * Detailed breakdown by pattern type for analysis.
   */
  it("should provide detailed accuracy metrics by pattern type", () => {
    if (NAME_INFERENCE_FIXTURE.length === 0) {
      return;
    }

    const patternStats = {
      dotSeparated: { total: 0, passed: 0 },
      underscoreSeparated: { total: 0, passed: 0 },
      camelCase: { total: 0, passed: 0 },
      allLowercase: { total: 0, passed: 0 },
      singleLetter: { total: 0, passed: 0 },
      other: { total: 0, passed: 0 },
    };

    for (const testCase of NAME_INFERENCE_FIXTURE) {
      const localPart = testCase.address.split("@")[0];
      let pattern: keyof typeof patternStats = "other";

      if (localPart.includes(".")) {
        pattern = "dotSeparated";
      } else if (localPart.includes("_")) {
        pattern = "underscoreSeparated";
      } else if (/[a-z][A-Z]/.test(localPart)) {
        pattern = "camelCase";
      } else if (/^[a-z][a-z]{5,}$/.test(localPart)) {
        pattern = "singleLetter";
      } else if (/^[a-z]+$/.test(localPart)) {
        pattern = "allLowercase";
      }

      const actual = inferNameFromAddress(testCase.address);
      const passed = actual === testCase.expectedName;

      patternStats[pattern].total++;
      if (passed) {
        patternStats[pattern].passed++;
      }
    }

    // Log stats
    console.log("\nPattern accuracy breakdown:");
    for (const [pattern, stats] of Object.entries(patternStats)) {
      if (stats.total > 0) {
        const rate = (stats.passed / stats.total) * 100;
        console.log(
          `  ${pattern}: ${stats.passed}/${stats.total} (${rate.toFixed(1)}%)`
        );
      }
    }

    // All patterns should have high accuracy
    for (const [, stats] of Object.entries(patternStats)) {
      if (stats.total > 0) {
        const rate = (stats.passed / stats.total) * 100;
        expect(rate).toBeGreaterThan(90); // Each pattern should be >90% accurate
      }
    }
  });
});
