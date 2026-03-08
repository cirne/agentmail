import OpenAI from "openai";
import type { SqliteDatabase } from "~/db";
import { config } from "~/lib/config";
import { normalizeMessageId } from "~/mcp";
import { formatMessageForOutput } from "~/messages/presenter";
import { toLeanMessage, DEFAULT_BODY_CAP } from "~/messages/lean-shape";
import { executeNanoTool } from "./tools";

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = config.openai.apiKey; // Throws if missing
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

interface FetchPlan {
  messageIds?: string[];
  threadIds?: string[];
}

/**
 * Parse nano's final message to extract recommended fetch list.
 * Looks for JSON structure with messageIds and/or threadIds.
 */

/**
 * Context assembler: fetch emails (bodies + attachments) and prepare context.
 */
async function assembleContext(
  db: SqliteDatabase,
  plan: FetchPlan,
  opts?: { maxMessages?: number; maxBodyChars?: number }
): Promise<string> {
  const maxMessages = opts?.maxMessages ?? 20;
  const maxBodyChars = opts?.maxBodyChars ?? DEFAULT_BODY_CAP;
  const parts: string[] = [];

  // Fetch messages by messageId
  if (plan.messageIds && plan.messageIds.length > 0) {
    const messageIds = plan.messageIds.slice(0, maxMessages);
    process.stderr.write(`[context assembler] fetching ${messageIds.length} messages by ID\n`);
    const placeholders = messageIds.map(() => "?").join(",");
    const messages = db
      .prepare(`SELECT * FROM messages WHERE message_id IN (${placeholders})`)
      .all(...messageIds) as any[];

    process.stderr.write(`[context assembler] found ${messages.length} messages in DB\n`);
    for (const msg of messages) {
      const shaped = await formatMessageForOutput(msg, false);
      const lean = toLeanMessage(shaped as any, maxBodyChars);
      const content = lean.content as { markdown?: string } | undefined;
      const markdown = content?.markdown || "";
      parts.push(
        `---\nFrom: ${lean.from_address}${lean.from_name ? ` (${lean.from_name})` : ""}\nSubject: ${lean.subject}\nDate: ${lean.date}${markdown ? `\n${markdown}` : ""}`
      );
    }
  }

  // Fetch threads by threadId
  if (plan.threadIds && plan.threadIds.length > 0) {
    process.stderr.write(`[context assembler] fetching ${Math.min(plan.threadIds.length, 5)} threads by ID\n`);
    for (const threadId of plan.threadIds.slice(0, 5)) {
      const messages = db
        .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY date ASC")
        .all(threadId) as any[];

      process.stderr.write(`[context assembler] thread ${threadId}: found ${messages.length} messages\n`);
      if (messages.length > 0) {
        parts.push(`\n=== Thread: ${messages[0].subject} ===\n`);
        for (const msg of messages.slice(0, 10)) {
          const shaped = await formatMessageForOutput(msg, false);
          const lean = toLeanMessage(shaped as any, maxBodyChars);
          const content = lean.content as { markdown?: string } | undefined;
          const markdown = content?.markdown || "";
          parts.push(
            `From: ${lean.from_address}${lean.from_name ? ` (${lean.from_name})` : ""} | Date: ${lean.date}${markdown ? `\n${markdown}\n` : "\n"}`
          );
        }
      }
    }
  }

  return parts.join("\n\n");
}

/**
 * Run the ask pipeline: Nano → Context assembler → Mini.
 */
export async function runAsk(
  question: string,
  db: SqliteDatabase,
  opts?: { stream?: boolean }
): Promise<void> {
  const startTime = Date.now();
  const client = getOpenAIClient();
  const stream = opts?.stream ?? true;

  // Step 1: Nano iterative search loop
  const MAX_TRIES = 5;
  // Get current date for context
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1; // 1-12
  const currentDateStr = `${currentYear}-${String(currentMonth).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const lastMonth = currentMonth === 1 ? 12 : currentMonth - 1;
  const lastMonthYear = currentMonth === 1 ? currentYear - 1 : currentYear;

  const nanoMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        `TODAY'S DATE: ${currentDateStr} (${now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}).\n` +
        `CURRENT YEAR: ${currentYear}. CURRENT MONTH: ${currentMonth}.\n` +
        `When the user says "last month", that means ${lastMonthYear}-${String(lastMonth).padStart(2, "0")}-01 to ${lastMonthYear}-${String(lastMonth).padStart(2, "0")}-${new Date(lastMonthYear, lastMonth, 0).getDate()} (${new Date(lastMonthYear, lastMonth - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })}).\n` +
        `IMPORTANT: Always use ${currentYear} as the current year when interpreting dates. Do NOT use 2024 or other years unless explicitly specified by the user.\n\n` +
        "You have tools to search email metadata (headers only, no body content) and find people. Use them iteratively to find messages needed to answer the user's question.\n\n" +
        "SEARCH STRATEGY - Think semantically:\n" +
        "- Think semantically about the question. What are the core concepts? What synonyms, related terms, domain variations, or alternative phrasings might appear in emails?\n" +
        "- For company/domain queries: try domain names (e.g., 'apple' → 'apple.com'), email patterns, brand variations.\n" +
        "- For event/trip queries: try event names, locations, dates, organizers, related terms.\n" +
        "- For spending/purchase queries: try synonyms ('spending', 'purchases', 'receipts', 'invoices', 'payments'), company domains.\n" +
        "- For person queries: use 'who' first to find email addresses, then search with 'fromAddress'.\n" +
        "- Use HIGH limits (50-100+) for broad queries. You have ~80k tokens available for metadata results total.\n" +
        "- If a search returns 0 results, DO NOT stop - try different terms immediately. Think semantically: what other words might emails use?\n" +
        "- If query asks for emails 'from X', try: 1) company name, 2) domain name (X.com), 3) fromAddress filter, 4) remove date filters if you added them.\n" +
        "- If search results indicate you have enough context (e.g., many results, diverse sources, hasEnoughContext hint), you can stop searching.\n" +
        "- Continue searching until you have comprehensive coverage OR you've tried enough variations (up to 5 attempts). Don't give up after 0-result searches.\n\n" +
        "IMPORTANT:\n" +
        "- For date filters, use 'afterDate' and 'beforeDate' parameters with relative dates (e.g., '7d', '30d', '1w', '3m') or ISO dates (YYYY-MM-DD).\n" +
        "- DEFAULT: Use 'afterDate: 30d' (30 days ago) as a default to focus on recent emails. Only remove this if the question explicitly asks for 'all emails', 'any emails', 'ever', 'everything', or similar language indicating no time limit.\n" +
        "- IMPORTANT: Do NOT use hardcoded old dates like '2023-02-08' or '2024-01-01'. Always use relative dates (30d, 7d) or dates based on the current year (${currentYear}). If you need to search all emails, omit date filters entirely.\n" +
        "- If the question explicitly mentions a time period (e.g., 'last month', 'this week', 'in February'), use that specific date range instead of the default.\n" +
        "- IMPORTANT: Use the current date provided above to interpret relative dates. 'last month' means the previous calendar month from the current date.\n" +
        "- Use keyword searches in the 'query' field. Do NOT use operators like 'category:' that don't exist.\n" +
        "- After calling 'who', you MUST call 'search' with 'fromAddress' set to their email address.\n" +
        "- Pay attention to search result hints: they tell you if you need more results or different terms.\n" +
        "- When you have enough results, output a recommended fetch list in JSON format: { \"messageIds\": [\"<id1>\", \"<id2>\"], \"threadIds\": [\"<id1>\"] }.",
    },
    {
      role: "user",
      content: question,
    },
  ];

  const toolResults: Array<{ name: string; result: string }> = [];
  // Store results with ranking: Map<messageId, { rank: number, fromQuery: string }>
  const rankedResults = new Map<string, { rank: number; fromQuery: string }>();
  const allThreadIds = new Set<string>();
  let attemptCount = 0;
  let hasEnoughContext = false;

  // Nano loop: search iteratively until we have enough or hit MAX_TRIES
  while (attemptCount < MAX_TRIES && !hasEnoughContext) {
    const response = await client.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: nanoMessages,
      tools: [
        {
          type: "function" as const,
          function: {
            name: "search",
            description:
              "Search emails by full-text and filters. Returns message list with headers/metadata only. Check the 'hasEnoughContext' hint in results to know if you should continue searching.",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string", description: "Full-text search query" },
                limit: {
                  type: "number",
                  description: "Maximum number of results (default: 50). Use 100+ for broad queries.",
                },
                fromAddress: { type: "string", description: "Filter by sender email address" },
                toAddress: { type: "string", description: "Filter by recipient email address" },
                subject: { type: "string", description: "Filter by subject" },
                afterDate: {
                  type: "string",
                  description: "Filter messages after this date. Use relative dates like '7d', '30d', '1w', '3m' or ISO dates.",
                },
                beforeDate: {
                  type: "string",
                  description: "Filter messages before this date. Use relative dates or ISO dates.",
                },
              },
              required: ["query"],
            },
          },
        },
        {
          type: "function" as const,
          function: {
            name: "who",
            description:
              "Find people by email or display name. Returns addresses and contact stats. Use to resolve 'who is X' or to get addresses before searching by sender.",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search query to match against email addresses or display names" },
                limit: { type: "number", description: "Maximum number of results (default: 10)" },
              },
              required: ["query"],
            },
          },
        },
      ],
      tool_choice: "auto",
    });

    const message = response.choices[0]?.message;
    if (!message) {
      throw new Error("No response from nano");
    }

    nanoMessages.push(message);

    if (message.tool_calls && message.tool_calls.length > 0) {
      attemptCount++;
      process.stderr.write(`[nano attempt ${attemptCount}/${MAX_TRIES}] tool calls: ${message.tool_calls.length}\n`);

      for (const toolCall of message.tool_calls) {
        if (toolCall.type !== "function") continue;
        const toolName = toolCall.function.name;
        let toolArgs = JSON.parse(toolCall.function.arguments || "{}");
        
        // Apply default 30-day filter for search queries, but respect "any"/"all" queries
        if (toolName === "search") {
          const queryLower = question.toLowerCase();
          const asksForAll = queryLower.includes("any ") || queryLower.includes("all ") || 
                            queryLower.includes("ever") || queryLower.match(/\bany\b/) ||
                            queryLower.match(/\ball\b/) || queryLower.includes("everything");
          
          // Validate dates nano generated - reject old dates unless explicitly requested
          if (toolArgs.afterDate) {
            const afterDateStr = String(toolArgs.afterDate);
            // Check if it's an ISO date and if it's too old (more than 1 year ago)
            if (/^\d{4}-\d{2}-\d{2}$/.test(afterDateStr)) {
              const dateYear = parseInt(afterDateStr.substring(0, 4), 10);
              if (dateYear < currentYear - 1 && !queryLower.includes(String(dateYear))) {
                // Nano generated an old date that wasn't requested - remove it
                process.stderr.write(`[nano] rejecting old date ${afterDateStr}, using default instead\n`);
                delete toolArgs.afterDate;
              }
            }
          }
          
          // Apply default if no dates specified and query doesn't ask for "all"
          if (!toolArgs.afterDate && !toolArgs.beforeDate && !asksForAll) {
            toolArgs.afterDate = "30d";
            process.stderr.write(`[nano] applying default 30d date filter\n`);
          }
          
          // Remove dates if query explicitly asks for "any"/"all"
          if (asksForAll && (toolArgs.afterDate || toolArgs.beforeDate)) {
            process.stderr.write(`[nano] query asks for "any/all" - removing date filters\n`);
            delete toolArgs.afterDate;
            delete toolArgs.beforeDate;
          }
        }
        
        process.stderr.write(`[nano] calling ${toolName}(${JSON.stringify(toolArgs)})\n`);

        const result = await executeNanoTool(db, toolName, toolArgs);
        toolResults.push({ name: toolName, result });

        // Check if we have enough context
        try {
          const parsed = JSON.parse(result);
          if (parsed.hasEnoughContext === true) {
            hasEnoughContext = true;
            process.stderr.write(`[nano] tool indicates we have enough context\n`);
          }
          if (parsed.results) {
            process.stderr.write(`[nano] ${toolName} returned ${parsed.results.length} results\n`);
            // Extract IDs with ranking - preserve relevance order
            const query = toolArgs.query || "";
            for (let i = 0; i < parsed.results.length; i++) {
              const r = parsed.results[i];
              if (r.messageId) {
                const messageId = normalizeMessageId(r.messageId);
                // Store with rank (lower rank = more relevant in FTS5)
                // If result already exists, keep the better (lower) rank
                const existing = rankedResults.get(messageId);
                const currentRank = r.rank !== undefined ? r.rank : i; // Use FTS5 rank if available, else position
                if (!existing || currentRank < existing.rank) {
                  rankedResults.set(messageId, { rank: currentRank, fromQuery: query });
                }
              }
              if (r.threadId) allThreadIds.add(normalizeMessageId(r.threadId));
            }
            // Heuristic: if we have 50+ unique messages AND they seem relevant to the query, probably enough
            // But don't stop if we haven't found what was specifically asked for (e.g., "from qantas" but got generic travel results)
            if (rankedResults.size >= 50) {
              // Check if results seem relevant - if query mentions specific sender/company, check if we found matches
              const queryLower = question.toLowerCase();
              const hasSpecificSender = queryLower.includes("from ") || queryLower.includes("sender");
              if (!hasSpecificSender) {
                hasEnoughContext = true;
                process.stderr.write(`[nano] heuristic: ${rankedResults.size} unique messages, enough context\n`);
              } else {
                process.stderr.write(`[nano] heuristic: ${rankedResults.size} messages but query asks for specific sender - continuing to search\n`);
              }
            }
          } else if (parsed.people) {
            process.stderr.write(`[nano] ${toolName} returned ${parsed.people.length} people\n`);
          }
        } catch {
          // Ignore parse errors
        }

        nanoMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }
    } else {
      // Final message from nano (no tool calls)
      const finalContent = message.content || "";
      process.stderr.write(`[nano] final message: ${finalContent.substring(0, 200)}${finalContent.length > 200 ? "..." : ""}\n`);
      
      // If we have results and nano says we're done, stop
      if (rankedResults.size > 0 && (finalContent.toLowerCase().includes("enough") || finalContent.toLowerCase().includes("sufficient") || finalContent.toLowerCase().includes("complete"))) {
        hasEnoughContext = true;
        process.stderr.write(`[nano] has results and indicates we're done\n`);
        break;
      }
      
      // If we have no results, don't stop - add message and continue loop to try different terms
      if (rankedResults.size === 0) {
        process.stderr.write(`[nano] no results yet, continuing to try different terms (attempt ${attemptCount + 1}/${MAX_TRIES})\n`);
        nanoMessages.push(message);
        attemptCount++;
        // Add a prompt to encourage trying different terms
        nanoMessages.push({
          role: "user",
          content: "You got 0 results. Think semantically about different search terms. Try variations like domain names (apple.com), different phrasings, synonyms, or related terms. Don't give up - keep searching.",
        });
        continue;
      }
      
      // We have some results but nano didn't explicitly say we're done - stop anyway
      break;
    }
  }

  // Sort results by rank (most relevant first) and take top N
  // If we have too many results, prioritize by relevance
  const sortedResults = Array.from(rankedResults.entries())
    .sort((a, b) => a[1].rank - b[1].rank) // Lower rank = more relevant
    .map(([messageId, info]) => ({ messageId, rank: info.rank, fromQuery: info.fromQuery }));
  
  // Filter out low-relevance results if we have many
  // If we have 100+ results, filter out those with rank > 20 (low relevance)
  let filteredResults = sortedResults;
  if (sortedResults.length > 100) {
    const relevanceThreshold = 20; // FTS5 rank threshold (higher = less relevant)
    filteredResults = sortedResults.filter((r) => r.rank <= relevanceThreshold);
    process.stderr.write(`[relevance filter] filtered ${sortedResults.length} → ${filteredResults.length} results (removed rank > ${relevanceThreshold})\n`);
  }
  
  // Limit to top 100 most relevant messages
  const MAX_RELEVANT_MESSAGES = 100;
  const topMessageIds = filteredResults.slice(0, MAX_RELEVANT_MESSAGES).map((r) => r.messageId);
  
  const fetchPlan: FetchPlan = {
    messageIds: topMessageIds,
    threadIds: Array.from(allThreadIds),
  };
  const messageIdsCount = fetchPlan.messageIds?.length ?? 0;
  const threadIdsCount = fetchPlan.threadIds?.length ?? 0;
  process.stderr.write(`[fetch plan] extracted: messageIds=${messageIdsCount} (top ${Math.min(rankedResults.size, MAX_RELEVANT_MESSAGES)} of ${rankedResults.size} by relevance), threadIds=${threadIdsCount}\n`);

  // Step 2: Assemble context

  const context = await assembleContext(db, fetchPlan);
  const messageCount = fetchPlan.messageIds?.length ?? 0;
  const threadCount = fetchPlan.threadIds?.length ?? 0;
  process.stderr.write(`[context] assembled ${context.length} chars from ${messageCount} messageIds, ${threadCount} threadIds\n`);
  if (context.length === 0) {
    process.stderr.write(`[context] WARNING: empty context - no emails fetched\n`);
  }

  // Step 3: Mini synthesis
  const miniMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "You are an email assistant. Answer the user's question using only the provided email context. Be concise; cite subject or sender when relevant. If you cannot find enough information in the context, say so.",
    },
    {
      role: "user",
      content: `${question}\n\n--- Email Context ---\n${context}`,
    },
  ];

  // Step 3: Mini synthesis
  if (stream) {
    const stream = await client.chat.completions.create({
      model: "gpt-4.1-mini",
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
  } else {
    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: miniMessages,
      stream: false,
    });

    const answer = response.choices[0]?.message?.content;
    if (answer) {
      console.log(answer);
    }
  }

  // Print timing to stderr
  const pipelineMs = Date.now() - startTime;
  process.stderr.write(`\npipelineMs: ${pipelineMs}\n`);
}
