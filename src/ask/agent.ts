import OpenAI from "openai";
import type { SqliteDatabase } from "~/db";
import { config } from "~/lib/config";
import { runPlanner } from "./planner";
import { scatter } from "./scatter";
import { assembleContext } from "./assemble";
import { setVerbose, verboseLog } from "./verbose";

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = config.openai.apiKey; // Throws if missing
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

/**
 * Run the ask pipeline: Planner → Scatter → Assemble → Synthesize.
 *
 * This is the new v2 architecture:
 * 1. Planner: Single Nano call produces a JSON search plan (~300ms)
 * 2. Scatter: Parallel FTS5 execution across all patterns (~50ms)
 * 3. Assemble: Tiered context assembly (~100ms)
 * 4. Synthesize: Single Nano call produces answer (~500ms-1s)
 *
 * Total target: 1.5-3s (vs 4-12s for v1 iterative approach).
 */
export async function runAsk(
  question: string,
  db: SqliteDatabase,
  opts?: { stream?: boolean; verbose?: boolean }
): Promise<string | undefined> {
  setVerbose(!!opts?.verbose);
  const startTime = Date.now();
  const client = getOpenAIClient();
  const stream = opts?.stream ?? true;

  // ============================================================================
  // STEP 1: PLANNER - Generate search plan from question
  // ============================================================================
  verboseLog(`[pipeline] step 1: planner\n`);
  const plan = await runPlanner(question);

  // ============================================================================
  // STEP 2: SCATTER - Execute all patterns in parallel
  // ============================================================================
  verboseLog(`[pipeline] step 2: scatter\n`);
  const hits = await scatter(plan, db);

  if (hits.length === 0) {
    verboseLog(`[pipeline] WARNING: no hits found. This may result in an incomplete answer.\n`);
  }

  // ============================================================================
  // STEP 3: ASSEMBLE - Build tiered context from hits
  // ============================================================================
  verboseLog(`[pipeline] step 3: assemble\n`);
  const context = await assembleContext(hits, plan, db, { question });

  if (context.length === 0) {
    verboseLog(`[pipeline] WARNING: empty context - no emails fetched\n`);
  }

  verboseLog(`[pipeline] assembled ${context.length} chars from ${hits.length} hits\n`);

  // ============================================================================
  // STEP 4: SYNTHESIZE - Generate answer from context
  // ============================================================================
  verboseLog(`[pipeline] step 4: synthesize\n`);
  const miniMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "You are an email assistant. Answer the user's question using only the provided email context. " +
        "Match your response length and detail to the complexity of the question. " +
        "For simple factual queries, be concise. " +
        "For broad synthesis across many emails, be thorough — surface specific details (dates, locations, names, amounts), " +
        "call out changes between drafts or revisions, and distinguish current state from superseded or cancelled plans. " +
        "Use structured formatting (sections, bullets, timeline) when synthesizing across many emails. " +
        "Cite subject or sender when relevant. If you cannot find enough information in the context, say so.",
    },
    {
      role: "user",
      content: `${question}\n\n--- Email Context ---\n${context}`,
    },
  ];

  if (stream) {
    const stream = await client.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: miniMessages,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        process.stdout.write(content);
      }
    }
    process.stdout.write("\n");
    // Print timing to stderr (stream path)
    const pipelineMs = Date.now() - startTime;
    verboseLog(`\npipelineMs: ${pipelineMs}\n`);
    return undefined;
  } else {
    const response = await client.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: miniMessages,
      stream: false,
    });

    const answer = response.choices[0]?.message?.content ?? "";
    // Print timing to stderr
    const pipelineMs = Date.now() - startTime;
    verboseLog(`\npipelineMs: ${pipelineMs}\n`);
    if (answer) {
      console.log(answer);
    }
    return answer;
  }
}
