import OpenAI from "openai";

export interface ComposeNewDraftResult {
  subject: string;
  body: string;
}

export type ComposeNewDraftLlmComplete = (
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
) => Promise<string>;

export interface ComposeNewDraftFromInstructionOptions {
  to: string[];
  instruction: string;
  apiKey: string;
  /** Override LLM call (tests). Must return the assistant message content (JSON object string). */
  complete?: ComposeNewDraftLlmComplete;
}

const SYSTEM_PROMPT = `You compose a new email from the user's instruction.

Return a single JSON object with exactly these keys:
- "subject" (string): a concise email subject line.
- "body" (string): the full message body. The user may want Markdown (headings, lists, emphasis); use it when it helps readability unless the instruction asks for plain text only.

Follow the instruction for tone, content, and length. Do not include a "Subject:" line inside the body.`;

/**
 * Generates subject and body for a new draft from a natural-language instruction.
 */
export async function composeNewDraftFromInstruction(
  opts: ComposeNewDraftFromInstructionOptions
): Promise<ComposeNewDraftResult> {
  const instruction = opts.instruction.trim();
  if (!instruction) {
    throw new Error("Compose instruction is empty");
  }
  if (opts.to.length === 0) {
    throw new Error("At least one recipient (to) is required");
  }

  const userContent = JSON.stringify({
    instruction,
    to: opts.to,
  });

  let raw: string;
  if (opts.complete) {
    raw = await opts.complete([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ]);
  } else {
    const client = new OpenAI({ apiKey: opts.apiKey });
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    });
    raw = completion.choices[0]?.message?.content?.trim() ?? "{}";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Model returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Model returned invalid shape");
  }
  const obj = parsed as { subject?: unknown; body?: unknown };
  if (typeof obj.subject !== "string" || obj.subject.trim() === "") {
    throw new Error('Model response must include a non-empty string "subject" field');
  }
  if (typeof obj.body !== "string") {
    throw new Error('Model response must include a string "body" field');
  }
  return { subject: obj.subject.trim(), body: obj.body };
}
