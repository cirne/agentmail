import OpenAI from "openai";
import type { DraftRecord } from "./draft-store";

export interface RewriteDraftResult {
  body: string;
  /** When present, replace the draft subject with this value. */
  subject?: string;
}

export type RewriteDraftLlmComplete = (
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
) => Promise<string>;

export interface RewriteDraftWithInstructionOptions {
  draft: DraftRecord;
  instruction: string;
  apiKey: string;
  /** Override LLM call (tests). Must return the assistant message content (JSON object string). */
  complete?: RewriteDraftLlmComplete;
}

const SYSTEM_PROMPT = `You revise an email draft based on the user's instruction.

Return a single JSON object with exactly these keys:
- "body" (string): the full revised message body only. No "Subject:" line inside the body. The user may use Markdown; preserve that style when appropriate unless the instruction asks otherwise.
- "subject" (string or null): a new subject line ONLY if the instruction clearly requires changing the subject; otherwise null.

Apply the instruction faithfully (remove sections, change tone, fix typos, shorten, etc.). Preserve parts the instruction does not ask to change. If something is ambiguous, prefer minimal edits.`;

/**
 * Rewrites a draft body (and optionally subject) using an LLM and the user's natural-language instruction.
 */
export async function rewriteDraftWithInstruction(
  opts: RewriteDraftWithInstructionOptions
): Promise<RewriteDraftResult> {
  const instruction = opts.instruction.trim();
  if (!instruction) {
    throw new Error("Rewrite instruction is empty");
  }

  const fm = opts.draft.frontmatter;
  const userContent = JSON.stringify({
    instruction,
    draftKind: fm.kind,
    recipients: {
      to: fm.to ?? [],
      cc: fm.cc ?? [],
      bcc: fm.bcc ?? [],
    },
    currentSubject: fm.subject ?? "",
    currentBody: opts.draft.body,
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
  const obj = parsed as { body?: unknown; subject?: unknown };
  if (typeof obj.body !== "string") {
    throw new Error('Model response must include a string "body" field');
  }
  const out: RewriteDraftResult = { body: obj.body };
  if (typeof obj.subject === "string" && obj.subject.trim() !== "") {
    out.subject = obj.subject.trim();
  }
  return out;
}
