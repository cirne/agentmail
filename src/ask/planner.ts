import OpenAI from "openai";
import { config } from "~/lib/config";
import { verboseLog } from "./verbose";

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = config.openai.apiKey; // Throws if missing
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

/**
 * Search plan produced by the planner.
 * This is the JSON structure that Nano outputs.
 */
export interface SearchPlan {
  patterns: string[]; // 3-8 keyword terms, each a plain word or short phrase
  fromAddress?: string; // Domain ("apple.com") or address if sender-specific
  toAddress?: string;
  afterDate?: string; // Relative ("30d", "7d") or ISO date
  beforeDate?: string;
  includeNoise: boolean; // true for newsletters, promotions
  reasoning?: string; // optional debug field
}

/**
 * Get current date context for the planner prompt.
 */
function getDateContext(): { currentDateStr: string; currentYear: number; currentMonth: number } {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1; // 1-12
  const currentDateStr = `${currentYear}-${String(currentMonth).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return { currentDateStr, currentYear, currentMonth };
}

/**
 * Fallback plan generator: extract basic patterns from question by splitting on spaces.
 * Used when JSON parsing fails.
 */
function createFallbackPlan(question: string): SearchPlan {
  const words = question
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2) // filter out short words like "a", "an", "the", "is", "my"
    .slice(0, 8); // max 8 patterns

  return {
    patterns: words.length > 0 ? words : [question.slice(0, 50)], // fallback to first 50 chars if no words
    includeNoise: false,
  };
}

/**
 * Run the planner: single Nano call with JSON output mode.
 * Returns a SearchPlan that can be executed by the scatter step.
 */
export async function runPlanner(question: string): Promise<SearchPlan> {
  const client = getOpenAIClient();
  const { currentDateStr, currentYear, currentMonth } = getDateContext();
  const lastMonth = currentMonth === 1 ? 12 : currentMonth - 1;
  const lastMonthYear = currentMonth === 1 ? currentYear - 1 : currentYear;

  const systemPrompt = `TODAY'S DATE: ${currentDateStr} (${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}).
CURRENT YEAR: ${currentYear}. CURRENT MONTH: ${currentMonth}.
When the user says "last month", that means ${lastMonthYear}-${String(lastMonth).padStart(2, "0")}-01 to ${lastMonthYear}-${String(lastMonth).padStart(2, "0")}-${new Date(lastMonthYear, lastMonth, 0).getDate()} (${new Date(lastMonthYear, lastMonth - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" })}).
IMPORTANT: Always use ${currentYear} as the current year when interpreting dates. Do NOT use 2024 or other years unless explicitly specified by the user.

You are a search planner for a local email index. Given a question, output a JSON search plan with two separate concerns:

1. METADATA FILTERS (structured SQL — always first-class):
   - fromAddress: domain or full address for a specific sender or vendor. Use whenever a company/service name or domain appears in a purchase, spending, receipt, or "from" context. Map well-known brands to their domain: Apple → "apple.com", Amazon → "amazon.com", Google → "google.com", Stripe → "stripe.com", GitHub → "github.com", Netflix → "netflix.com", Spotify → "spotify.com", etc. Also use when user says "from X" or "emails from X".
   - toAddress: recipient address/domain, only when user asks about emails sent to someone.
   - afterDate: ISO date (YYYY-MM-DD) or relative value ("30d", "7d", "1w", "3m", "0d"). Set whenever the question mentions a time period. Convert US date formats: "1/1/26" → "2026-01-01", "since Jan 2026" → "2026-01-01". For "today" use "0d".
   - beforeDate: same format as afterDate.

2. PATTERNS (FTS5 full-text search — content keywords only):
   - patterns: 1-6 plain words describing what the email is ABOUT. Never put domains, addresses, or dates here.
   - For vendor/spending queries: use transaction keywords like "receipt", "purchase", "order", "invoice" — NOT the vendor name (that goes in fromAddress).
   - For person queries: name variations, e.g. ["marcio", "nunes"].
   - For generic date-only or listing queries ("today", "recent", "5 most recent", "list all from X"): use empty patterns [].

Rules:
- Set includeNoise: true for newsletter/news questions. Otherwise false.
- Never hardcode old years. Always derive dates from TODAY'S DATE above.

Examples:
- "list all apple purchases since 1/1/26" → {"patterns": ["receipt", "purchase", "order"], "fromAddress": "apple.com", "afterDate": "2026-01-01", "includeNoise": false}
- "summarize my spending on apple.com in the last 30 days" → {"patterns": ["receipt", "purchase", "order", "invoice"], "fromAddress": "apple.com", "afterDate": "30d", "includeNoise": false}
- "invoices from stripe" → {"patterns": ["invoice", "receipt", "payment"], "fromAddress": "stripe.com", "includeNoise": false}
- "who is marcio nunes" → {"patterns": ["marcio", "nunes"], "includeNoise": false}
- "what are my 5 most recent emails" → {"patterns": [], "includeNoise": false}
- "emails about the cabo trip" → {"patterns": ["cabo", "trip", "travel"], "includeNoise": false}

Output JSON only.`;

  verboseLog(`[planner] calling Nano to generate search plan\n`);

  try {
    const response = await client.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: question,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3, // Lower temperature for more consistent planning
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      verboseLog(`[planner] no response from Nano, using fallback plan\n`);
      return createFallbackPlan(question);
    }

    try {
      const plan = JSON.parse(content) as SearchPlan;
      
      // Validate plan structure (empty patterns is valid for date-only queries)
      if (!Array.isArray(plan.patterns)) {
        verboseLog(`[planner] invalid plan: patterns missing, using fallback\n`);
        return createFallbackPlan(question);
      }

      // Ensure includeNoise is boolean
      if (typeof plan.includeNoise !== "boolean") {
        plan.includeNoise = false;
      }

      verboseLog(`[planner] generated plan: ${plan.patterns.length} patterns, fromAddress=${plan.fromAddress ?? "none"}, afterDate=${plan.afterDate ?? "none"}, includeNoise=${plan.includeNoise}\n`);
      return plan;
    } catch (parseError) {
      verboseLog(`[planner] JSON parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}, using fallback plan\n`);
      return createFallbackPlan(question);
    }
  } catch (error) {
    verboseLog(`[planner] API error: ${error instanceof Error ? error.message : String(error)}, using fallback plan\n`);
    return createFallbackPlan(question);
  }
}
