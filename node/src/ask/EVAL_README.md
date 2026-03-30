# zmail ask Evaluation Suite

This directory contains an evaluation suite for `zmail ask` using **LLM-as-a-judge** methodology.

## Overview

The eval suite (`ask.eval.test.ts`) evaluates `zmail ask` answers using:
1. **LLM-as-a-judge**: Uses GPT-4o-mini to evaluate answer quality (score 0-1)
2. **Performance metrics**: Measures latency per query
3. **Test cases**: Predefined questions with evaluation criteria

## Running the Eval Suite

**Prerequisites:**
- `ZMAIL_OPENAI_API_KEY` environment variable must be set
- Test database with email data (tests create their own test data)

**Run all eval tests:**
```bash
npm test -- ask.eval.test.ts
```

**Run a specific test:**
```bash
npm test -- ask.eval.test.ts -t "should answer: who is marcio nunes"
```

## Test Structure

Each test case in `EVAL_CASES` includes:
- **question**: The query to test
- **setup**: Function to populate test database with relevant emails
- **criteria**: Evaluation criteria (mustInclude, expectedTopics, etc.)
- **maxLatencyMs**: Maximum acceptable latency
- **minScore**: Minimum LLM judge score (default: 0.7)

## Adding New Test Cases

Add new cases to the `EVAL_CASES` array:

```typescript
{
  question: "your question here",
  description: "Brief description",
  setup: (db) => {
    insertTestMessage(db, {
      messageId: "<msg@example.com>",
      subject: "Test",
      bodyText: "Relevant content",
      // ... other fields
    });
  },
  criteria: {
    mustInclude: ["keyword1", "keyword2"],
    expectedTopics: ["topic1", "topic2"],
    minLength: 50,
  },
  maxLatencyMs: 20000,
}
```

## LLM Judge Evaluation

The `evaluateAnswerWithLLM` function uses GPT-4o-mini to evaluate answers based on:
- **Accuracy**: Does the answer correctly address the question?
- **Completeness**: Does it include all relevant information?
- **Relevance**: Is the information directly related to the question?
- **Clarity**: Is the answer clear and well-structured?

Scores range from 0.0 to 1.0, with 0.7+ considered passing.

## Output

Each test logs:
- Question and answer
- Answer length (characters)
- Latency (milliseconds)
- LLM judge score and reasoning

Example output:
```
[Eval] Question: who is marcio nunes and how do I know him?
[Eval] Answer length: 156 chars
[Eval] Latency: 8450ms
[Eval] LLM Score: 0.85/1.0
[Eval] Reasoning: The answer correctly identifies Marcio Nunes as CEO & Founder of Harmonee AI and mentions meeting at a conference...
[Eval] Answer: Marcio Nunes is the CEO & Founder of Harmonee AI. You met him at a conference last month...
```

## Performance Benchmarks

The suite includes performance benchmarks to track latency over time. Simple queries should complete in <15s.

## See Also

- [`docs/ASK.md`](../../docs/ASK.md) - Using `zmail ask` as a higher-level query interface
- [`src/ask/agent.ts`](./agent.ts) - Implementation of the ask pipeline
