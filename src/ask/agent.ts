import OpenAI from "openai";
import { join } from "node:path";
import type { SqliteDatabase } from "~/db";
import { config } from "~/lib/config";
import { formatMessageForOutput } from "~/messages/presenter";
import { toLeanMessage, DEFAULT_BODY_CAP } from "~/messages/lean-shape";
import { extractAndCache } from "~/attachments";
import { executeNanoTool } from "./tools";
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
 * Determine if attachments should be included based on query analysis.
 */
function shouldIncludeAttachments(question: string): boolean {
  const questionLower = question.toLowerCase();
  
  // Keywords that suggest attachments are relevant
  const attachmentKeywords = [
    "attachment", "attached", "file", "document", "spreadsheet", "excel", "xlsx", "csv",
    "pdf", "invoice", "receipt", "statement", "report", "quote", "quotation",
    "line item", "line items", "breakdown", "details", "data", "table",
    "funds request", "payment", "bill", "billing", "expense", "cost", "price",
    "contract", "agreement", "proposal", "estimate"
  ];
  
  return attachmentKeywords.some(keyword => questionLower.includes(keyword));
}

/**
 * Determine if a specific attachment should be included.
 * Simple rule-based filtering: size limits and type exclusions only.
 * We don't try to determine relevance - let the LLM handle that from context.
 * Returns { include: boolean, reason?: string }
 */
function shouldIncludeAttachment(
  att: { filename: string; mime_type: string; size: number; extracted_text: string | null },
  totalAttachmentChars: number
): { include: boolean; reason?: string } {
  const MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
  const MAX_EXTRACTED_TEXT_CHARS = 50000; // ~50k chars per attachment
  const MAX_TOTAL_ATTACHMENT_CHARS = 200000; // ~200k chars total across all attachments
  
  // Skip if file is too large (likely binary or huge document)
  if (att.size > MAX_ATTACHMENT_SIZE_BYTES) {
    return { include: false, reason: `attachment too large (${(att.size / 1024 / 1024).toFixed(1)} MB)` };
  }
  
  // Skip images, videos, audio unless they're small (likely thumbnails/icons)
  const nonTextTypes = ["image/", "video/", "audio/"];
  if (nonTextTypes.some(type => att.mime_type.startsWith(type)) && att.size > 500 * 1024) {
    return { include: false, reason: `non-text attachment type (${att.mime_type}), size ${(att.size / 1024).toFixed(0)} KB` };
  }
  
  // If we already have a lot of attachment content, skip larger attachments
  if (totalAttachmentChars > MAX_TOTAL_ATTACHMENT_CHARS / 2 && att.size > 100 * 1024) {
    return { include: false, reason: "total attachment content limit approaching" };
  }
  
  // Check extracted text size if already extracted
  if (att.extracted_text && att.extracted_text.length > MAX_EXTRACTED_TEXT_CHARS) {
    return { include: false, reason: `extracted text too long (${att.extracted_text.length} chars)` };
  }
  
  return { include: true };
}

/**
 * Context assembler: fetch emails (bodies + attachments) and prepare context.
 */
async function assembleContext(
  db: SqliteDatabase,
  messageIds: string[],
  attachmentIds: number[],
  opts?: { maxMessages?: number; maxBodyChars?: number; question?: string }
): Promise<string> {
  const maxMessages = opts?.maxMessages ?? 50;
  const maxBodyChars = opts?.maxBodyChars ?? DEFAULT_BODY_CAP;
  const question = opts?.question ?? "";
  const specificAttachmentIds = attachmentIds.length > 0 ? new Set(attachmentIds) : null;
  const parts: string[] = [];

  // Fetch messages by messageId
  if (messageIds && messageIds.length > 0) {
    const messageIdsToFetch = messageIds.slice(0, maxMessages);
    verboseLog(`[context assembler] fetching ${messageIdsToFetch.length} messages by ID\n`);
    const placeholders = messageIdsToFetch.map(() => "?").join(",");
    const messages = db
      .prepare(`SELECT * FROM messages WHERE message_id IN (${placeholders})`)
      .all(...messageIdsToFetch) as any[];

    verboseLog(`[context assembler] found ${messages.length} messages in DB\n`);
    for (const msg of messages) {
      const shaped = await formatMessageForOutput(msg, false);
      const lean = toLeanMessage(shaped as any, maxBodyChars);
      const content = lean.content as { markdown?: string } | undefined;
      const markdown = content?.markdown || "";
      
      // Fetch attachments - either specific ones from context set, or filter by relevance if none specified
      let attachmentContent = "";
      let totalAttachmentChars = 0;
      
      // Only process attachments if we have specific IDs or if query suggests relevance
      const shouldProcessAttachments = specificAttachmentIds !== null || shouldIncludeAttachments(question);
      
      if (shouldProcessAttachments) {
        const attachments = db
          .prepare(`SELECT id, filename, mime_type, size, stored_path, extracted_text FROM attachments WHERE message_id = ? ORDER BY filename`)
          .all(msg.message_id) as Array<{ id: number; filename: string; mime_type: string; size: number; stored_path: string; extracted_text: string | null }>;
        
        if (attachments.length > 0) {
          const attachmentParts: string[] = [];
          for (const att of attachments) {
            // If specific attachment IDs were provided, only include those
            if (specificAttachmentIds && !specificAttachmentIds.has(att.id)) {
              continue;
            }
            
            // Otherwise, use filtering logic
            if (!specificAttachmentIds) {
              const shouldInclude = shouldIncludeAttachment(att, totalAttachmentChars);
              if (!shouldInclude.include) {
                verboseLog(`[context assembler] skipping attachment ${att.filename}: ${shouldInclude.reason}\n`);
                continue;
              }
            }
            
            let extractedText = att.extracted_text;
            
            // Extract on-demand if not already extracted
            if (!extractedText && att.stored_path) {
              try {
                const absPath = join(config.maildirPath, att.stored_path);
                const result = await extractAndCache(absPath, att.mime_type, att.filename, att.id, false);
                extractedText = result.text;
                
                // Check size after extraction
                if (extractedText.length > 50000) {
                  verboseLog(`[context assembler] extracted text too long (${extractedText.length} chars), truncating\n`);
                  extractedText = extractedText.slice(0, 50000) + "\n[... truncated ...]";
                }
              } catch (err) {
                extractedText = `[Failed to extract attachment: ${err instanceof Error ? err.message : String(err)}]`;
              }
            }
            
            if (extractedText) {
              const attachmentText = `\n--- Attachment: ${att.filename} (${att.mime_type}) ---\n${extractedText}`;
              attachmentParts.push(attachmentText);
              totalAttachmentChars += attachmentText.length;
            } else {
              attachmentParts.push(`\n--- Attachment: ${att.filename} (${att.mime_type}) ---\n[Attachment not extracted]`);
            }
          }
          attachmentContent = attachmentParts.join("\n");
        }
      }
      
      parts.push(
        `---\nFrom: ${lean.from_address}${lean.from_name ? ` (${lean.from_name})` : ""}\nSubject: ${lean.subject}\nDate: ${lean.date}${markdown ? `\n${markdown}` : ""}${attachmentContent}`
      );
    }
  }

  // Note: Thread fetching removed - nano now builds curated context set directly
  // If needed in future, can add thread support back

  return parts.join("\n\n");
}

/**
 * Run the ask pipeline: Nano (investigation) → Context assembler → Mini (synthesis).
 * Phase 1: Nano explores emails using metadata-only tools to find relevant candidates.
 * Context Assembly: Fetches full email bodies and attachments from candidates.
 * Phase 2: Mini synthesizes the answer from assembled context.
 */
/**
 * Run the ask pipeline. When stream is false, returns the answer string for programmatic use (e.g. tests).
 * When stream is true, writes the answer to stdout and returns undefined.
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

  const MAX_TRIES = 5;
  // Get current date for context
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1; // 1-12
  const currentDateStr = `${currentYear}-${String(currentMonth).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const lastMonth = currentMonth === 1 ? 12 : currentMonth - 1;
  const lastMonthYear = currentMonth === 1 ? currentYear - 1 : currentYear;

  // Import tool definitions
  const { getInvestigationToolDefinitions } = await import("./tools");

  // ============================================================================
  // PHASE 1: INVESTIGATION - Search and explore to find relevant messages
  // Nano uses metadata-only tools (search, get_message, get_thread_headers)
  // to discover candidate messages and attachments without fetching full bodies.
  // ============================================================================
  verboseLog(`[phase 1] investigation: searching for relevant messages\n`);
  
  const investigationMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        `TODAY'S DATE: ${currentDateStr} (${now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}).\n` +
        `CURRENT YEAR: ${currentYear}. CURRENT MONTH: ${currentMonth}.\n` +
        `When the user says "last month", that means ${lastMonthYear}-${String(lastMonth).padStart(2, "0")}-01 to ${lastMonthYear}-${String(lastMonth).padStart(2, "0")}-${new Date(lastMonthYear, lastMonth, 0).getDate()} (${new Date(lastMonthYear, lastMonth - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })}).\n` +
        `IMPORTANT: Always use ${currentYear} as the current year when interpreting dates. Do NOT use 2024 or other years unless explicitly specified by the user.\n\n` +
        "You are an email investigator. Your job is to search and explore emails to find messages and attachments relevant to answering the user's question.\n\n" +
        "PHASE 1 - INVESTIGATION ONLY:\n" +
        "- Use 'search' to discover relevant messages. Search results show metadata (subject, from, date, snippet, attachments) but NOT full body content.\n" +
        "- Use 'get_message' to read full message content when you need to understand what a message says.\n" +
        "- Use 'get_thread_headers' to explore thread structure.\n" +
        "- When you have found the relevant messages and attachments, summarize what you found and say \"investigation complete\".\n\n" +
        "SEARCH STRATEGY - Construct effective FTS5 queries:\n" +
        "- CRITICAL: FTS5 treats space-separated words as AND (all must match). Use OR operator (uppercase) for alternatives.\n" +
        "- Extract core nouns/concepts from the question. Remove action words (suggest, recommend, said, want, need, did, does, show, find).\n" +
        "- Construct queries intelligently:\n" +
        "  * Question mentions alternatives → use OR: 'invoice or receipt' → 'invoice OR receipt'\n" +
        "  * Question has person + topic → try 'dan cabo' OR 'cabo'\n" +
        "  * Question has multiple related terms → use OR for flexibility: 'funds request' OR 'request funds'\n" +
        "  * Question asks 'what did X suggest/recommend' → remove action word: 'dan cabo' (not 'dan suggest cabo')\n" +
        "- Query construction examples:\n" +
        "  * 'what did dan suggest for cabo?' → 'dan cabo' OR 'cabo'\n" +
        "  * 'latest invoice or receipt' → 'invoice OR receipt'\n" +
        "  * 'funds request from rudy' → 'funds request' OR 'rudy funds'\n" +
        "  * 'flight or travel plans' → 'flight OR travel'\n" +
        "- Keep queries focused: 2-3 terms maximum, or use OR to combine 2-3 alternatives\n" +
        "- BAD: 'dan cabo suggestion' (3 words AND - too specific), 'what did dan suggest' (action words)\n" +
        "- GOOD: 'dan cabo' (2 terms), 'invoice OR receipt' (alternatives), 'funds request' (2 related terms)\n" +
        "- For company/domain queries: try domain names (e.g., 'apple' → 'apple.com'), email patterns, brand variations.\n" +
        "- For event/trip queries: try event names, locations, dates, organizers, related terms.\n" +
        "- For spending/purchase queries: try synonyms ('spending', 'purchases', 'receipts', 'invoices', 'payments'), company domains.\n" +
        "- For person + topic questions (e.g. 'what is the situation for Dan and Cabo?'), search with both terms: 'dan cabo' or 'dan cabo' OR 'cabo'. Do not require fromAddress/toAddress — relevant emails may be from other participants.\n" +
        "- Use HIGH limits (50-100+) for broad queries. You have ~80k tokens available for metadata results total.\n" +
        "- If a search returns 0 results, DO NOT stop - try simpler queries with fewer words. Remove action words - just use nouns.\n" +
        "- If query asks for emails 'from X', you can use fromAddress when you have an address; try company/domain or broader search if needed.\n" +
        "- TOPIC-BASED QUESTIONS: If the question asks for emails about a topic (e.g. 'find any emails about invoices', 'emails about receipts', 'who is X', 'meeting with Y'), you MUST call search() WITH a query containing that topic. Use the topic as the query (e.g. query: 'invoice' or 'invoice OR receipt'). Do NOT use filter-only search (no query) for topic-based questions — that returns only recent messages by date and will miss the relevant emails.\n" +
        "- BROWSING RECENT MESSAGES: Only when the user asks for recent/latest/newest messages WITHOUT a specific topic (e.g., 'what are my 5 most recent messages?', 'what did I get today?'), call search() with NO query and use afterDate + limit to browse by date. Example: search({limit: 10}) or search({afterDate: '1d', limit: 5}) for today. Do not use browse-by-date when the user asked for a topic (invoices, person, company, etc.).\n" +
        "- If the question asks for \"latest\", \"recent\", or \"newest\" and also a topic, use query with the topic and omit or widen date filters so you don't exclude matches.\n" +
        "- If search results show attachments (e.g., 'attachments: [{\"id\": 107, \"filename\": \"...xlsx\"}]'), note them for context assembly.\n\n" +
        "IMPORTANT:\n" +
        "- For date filters, use 'afterDate' and 'beforeDate' parameters with relative dates (e.g., '7d', '30d', '1w', '3m') or ISO dates (YYYY-MM-DD).\n" +
        "- Only add date filters if the question explicitly mentions a time period (e.g., 'last month', 'this week', 'in February', 'in January'). If no time period is mentioned, search all emails without date filters.\n" +
        "- IMPORTANT: Date words like 'tomorrow', 'today', 'yesterday', 'next week', 'this week', 'last week' in the question or query are AUTOMATICALLY extracted and converted to date filters. You don't need to include them in your search query - focus on the content words (e.g., for 'advisory meeting tomorrow', search for 'advisory meeting' and the system will automatically filter by tomorrow's date).\n" +
        "- IMPORTANT: Do NOT use hardcoded old dates like '2023-02-08' or '2024-01-01'. Always use relative dates (30d, 7d) or dates based on the current year (${currentYear}). If you need to search all emails, omit date filters entirely.\n" +
        "- IMPORTANT: Use the current date provided above to interpret relative dates. 'last month' means the previous calendar month from the current date.\n" +
        "- Use keyword searches in the 'query' field. Do NOT use operators like 'category:' that don't exist.\n" +
        "- Pay attention to search result hints: they tell you if you need more results or different terms.",
    },
    {
      role: "user",
      content: question,
    },
  ];

  // Track investigation results: candidate messageIds and attachmentIds
  const candidateMessageIds = new Set<string>();
  const candidateAttachmentIds = new Set<number>();
  
  // Track search calls for retry fallback (if Phase 1 finds nothing, retry with includeNoise=true)
  const searchHistory: Array<{ query?: string; args: Record<string, unknown> }> = [];
  
  // Track consecutive failed filtered searches to prompt for broader searches
  let consecutiveFilteredFailures = 0;

  /**
   * Collect candidate messageIds and attachmentIds from a tool result.
   * Handles both search results (array) and get_message results (single object).
   */
  function collectCandidatesFromResult(result: string): { resultCount: number; newMessages: number } {
    try {
      const parsed = JSON.parse(result);
      let resultCount = 0;
      const beforeCount = candidateMessageIds.size;

      if (parsed.results && Array.isArray(parsed.results)) {
        // Search results: array of messages
        resultCount = parsed.results.length;
        for (const r of parsed.results) {
          if (r.messageId) candidateMessageIds.add(r.messageId);
          if (r.attachments && Array.isArray(r.attachments)) {
            for (const att of r.attachments) {
              if (att.id) candidateAttachmentIds.add(att.id);
            }
          }
        }
      } else if (parsed.messageId) {
        // get_message result: single message
        resultCount = 1;
        candidateMessageIds.add(parsed.messageId);
        if (parsed.attachments && Array.isArray(parsed.attachments)) {
          for (const att of parsed.attachments) {
            if (att.id) candidateAttachmentIds.add(att.id);
          }
        }
      }

      const newMessages = candidateMessageIds.size - beforeCount;
      return { resultCount, newMessages };
    } catch {
      // Ignore parse errors
      return { resultCount: 0, newMessages: 0 };
    }
  }

  // Phase 1: Investigation loop
  let investigationAttemptCount = 0;
  let investigationComplete = false;
  
  while (investigationAttemptCount < MAX_TRIES && !investigationComplete) {
    const response = await client.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: investigationMessages,
      tools: getInvestigationToolDefinitions(),
      tool_choice: "auto",
    });

    const message = response.choices[0]?.message;
    if (!message) {
      throw new Error("No response from nano");
    }

    investigationMessages.push(message);

    if (message.tool_calls && message.tool_calls.length > 0) {
      investigationAttemptCount++;
      verboseLog(`[phase 1 investigation ${investigationAttemptCount}/${MAX_TRIES}] tool calls: ${message.tool_calls.length}\n`);

      for (const toolCall of message.tool_calls) {
        if (toolCall.type !== "function") continue;
        const toolName = toolCall.function.name;
        let toolArgs = JSON.parse(toolCall.function.arguments || "{}");
        
        // Validate and clean up date filters for search queries
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
                verboseLog(`[nano] rejecting old date ${afterDateStr}\n`);
                delete toolArgs.afterDate;
              }
            }
          }
          
          // Remove dates if query explicitly asks for "any"/"all"
          if (asksForAll && (toolArgs.afterDate || toolArgs.beforeDate)) {
            verboseLog(`[nano] query asks for "any/all" - removing date filters\n`);
            delete toolArgs.afterDate;
            delete toolArgs.beforeDate;
          }
          
          // Track search calls for retry fallback
          searchHistory.push({
            query: toolArgs.query,
            args: { ...toolArgs },
          });
        }
        
        const hasFromAddress = toolName === "search" && toolArgs.fromAddress && String(toolArgs.fromAddress).trim() !== "";
        const hasToAddress = toolName === "search" && toolArgs.toAddress && String(toolArgs.toAddress).trim() !== "";

        verboseLog(`[phase 1] calling ${toolName}(${JSON.stringify(toolArgs)})\n`);

        // Phase 1: Investigation only
        const result = await executeNanoTool(db, toolName, toolArgs);
        
        // Collect candidate messageIds and attachmentIds from tool results
        if (toolName === "search" || toolName === "get_message") {
          const { resultCount, newMessages } = collectCandidatesFromResult(result);
          
          if (toolName === "search") {
            verboseLog(`[phase 1] search returned ${resultCount} results (${newMessages} new candidates), total: ${candidateMessageIds.size} messages, ${candidateAttachmentIds.size} attachments\n`);
            
            // If search with filters returned 0 results, track it
            if (resultCount === 0 && (hasFromAddress || hasToAddress)) {
              consecutiveFilteredFailures++;
              verboseLog(`[phase 1] filtered search returned 0 results (${consecutiveFilteredFailures} consecutive failures) - filtered by ${hasFromAddress ? `fromAddress=${toolArgs.fromAddress}` : ""} ${hasToAddress ? `toAddress=${toolArgs.toAddress}` : ""}\n`);
              
              // After 2 consecutive filtered failures, prompt to try without filters
              if (consecutiveFilteredFailures >= 2 && investigationAttemptCount < MAX_TRIES - 1) {
                verboseLog(`[phase 1] prompting to try searches without filters after ${consecutiveFilteredFailures} filtered failures\n`);
                investigationMessages.push({
                  role: "tool",
                  tool_call_id: toolCall.id,
                  content: result,
                });
                investigationMessages.push({
                  role: "user",
                  content: `You've tried ${consecutiveFilteredFailures} filtered searches and got 0 results. IMMEDIATELY try the same queries WITHOUT fromAddress/toAddress filters. For example, if you searched "dan suggest cabo" with filters, try "dan cabo" without any filters. Also try just "cabo" alone.`,
                });
                consecutiveFilteredFailures = 0; // Reset counter
                continue; // Skip adding tool result again below
              }
            } else if (resultCount > 0) {
              // Reset counter on success
              consecutiveFilteredFailures = 0;
            }
          }
        }

        // Log tool results for debugging
        try {
          const parsed = JSON.parse(result);
          if (parsed.results) {
            verboseLog(`[phase 1] ${toolName} returned ${parsed.results.length} results\n`);
          }
        } catch {
          // Ignore parse errors
        }

        investigationMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }

    } else {
      // Final message from investigation phase
      let finalContent = "";
      const msgContent: string | Array<{ type?: string; text?: string }> | null | undefined = message.content as any;
      if (typeof msgContent === "string") {
        finalContent = msgContent;
      } else if (Array.isArray(msgContent)) {
        finalContent = msgContent
          .filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof p?.text === "string")
          .map((p) => p.text)
          .join("\n");
      }
      verboseLog(`[phase 1] final message: ${finalContent.substring(0, 200)}${finalContent.length > 200 ? "..." : ""}\n`);
      
      // Check if investigation is complete
      const contentLower = finalContent.toLowerCase();
      if (contentLower.includes("investigation complete") || 
          contentLower.includes("ready for context assembly") ||
          contentLower.includes("ready to assemble") ||
          candidateMessageIds.size > 0) {
        investigationComplete = true;
        verboseLog(`[phase 1] investigation complete. Found ${candidateMessageIds.size} candidate messages, ${candidateAttachmentIds.size} candidate attachments\n`);
        break;
      }
      
      // If we have no candidates and haven't hit max attempts, prompt to try broader searches
      if (candidateMessageIds.size === 0 && investigationAttemptCount < MAX_TRIES - 1) {
        investigationMessages.push(message);
        investigationAttemptCount++;
        verboseLog(`[phase 1] no candidates found yet, prompting to try broader searches (attempt ${investigationAttemptCount}/${MAX_TRIES})\n`);
        
        // Extract person name and topic from question for more specific guidance
        const questionLower = question.toLowerCase();
        let guidance = "You haven't found any candidate messages yet. Try these searches:\n";
        guidance += "1. Remove ALL filters (no fromAddress/toAddress) and search with just the person's name + topic\n";
        if (questionLower.includes("dan") && questionLower.includes("cabo")) {
          guidance += "2. Try: 'dan cabo' (without filters)\n";
          guidance += "3. Try: 'cabo' (without filters)\n";
        } else {
          guidance += "2. Try: person name + topic (e.g., if question is 'what did X suggest about Y?', try 'X Y')\n";
          guidance += "3. Try: just the topic alone\n";
        }
        guidance += "Don't give up - filtered searches often fail, but broader searches usually work.";
        
        investigationMessages.push({
          role: "user",
          content: guidance,
        });
        continue;
      }
      
      // Continue investigation or finish
      investigationMessages.push(message);
      investigationAttemptCount++;
      if (investigationAttemptCount >= MAX_TRIES) {
        investigationComplete = true;
        verboseLog(`[phase 1] reached max attempts, moving to context assembly with ${candidateMessageIds.size} candidates\n`);
        break;
      }
    }
  }

  // ============================================================================
  // RETRY FALLBACK - If Phase 1 found nothing, retry searches with includeNoise=true
  // ============================================================================
  if (candidateMessageIds.size === 0 && searchHistory.length > 0) {
    verboseLog(`[phase 1 retry] no candidates found, retrying ${searchHistory.length} searches with includeNoise=true\n`);
    
    for (const search of searchHistory) {
      const retryArgs = { ...search.args, includeNoise: true };
      verboseLog(`[phase 1 retry] retrying search(${JSON.stringify(retryArgs)})\n`);
      
      const result = await executeNanoTool(db, "search", retryArgs);
      const { resultCount, newMessages } = collectCandidatesFromResult(result);
      verboseLog(`[phase 1 retry] search returned ${resultCount} results (${newMessages} new candidates)\n`);
    }
    
    if (candidateMessageIds.size > 0) {
      verboseLog(`[phase 1 retry] found ${candidateMessageIds.size} candidates after retry with includeNoise=true\n`);
    } else {
      verboseLog(`[phase 1 retry] still no candidates after retry\n`);
    }
  }

  // ============================================================================
  // CONTEXT ASSEMBLY - Use Phase 1 candidates directly
  // ============================================================================
  const messageIdsToFetch = Array.from(candidateMessageIds);
  const attachmentIdsToFetch = Array.from(candidateAttachmentIds);
  
  verboseLog(`[context assembly] using ${messageIdsToFetch.length} candidate messages, ${attachmentIdsToFetch.length} candidate attachments\n`);
  
  if (messageIdsToFetch.length === 0) {
    verboseLog(`[context assembly] WARNING: no candidate messages found. This may result in an incomplete answer.\n`);
  }

  // Assemble context using the candidates from Phase 1
  const context = await assembleContext(db, messageIdsToFetch, attachmentIdsToFetch, { question });
  const messageCount = messageIdsToFetch.length;
  const attachmentCount = attachmentIdsToFetch.length;
  verboseLog(`[context] assembled ${context.length} chars from ${messageCount} messageIds, ${attachmentCount} attachments\n`);
  if (context.length === 0) {
    verboseLog(`[context] WARNING: empty context - no emails fetched\n`);
  }

  // ============================================================================
  // PHASE 2: MINI SYNTHESIS - Generate answer from assembled context
  // ============================================================================
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
    // Print timing to stderr (stream path)
    const pipelineMs = Date.now() - startTime;
    verboseLog(`\npipelineMs: ${pipelineMs}\n`);
    return undefined;
  } else {
    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
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
