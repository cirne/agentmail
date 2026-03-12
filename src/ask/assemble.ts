import { join } from "node:path";
import type { SqliteDatabase } from "~/db";
import { config } from "~/lib/config";
import { formatMessageForOutput } from "~/messages/presenter";
import { toLeanMessage } from "~/messages/lean-shape";
import { extractAndCache } from "~/attachments";
import type { SearchResult } from "~/lib/types";
import type { SearchPlan } from "./planner";
import { verboseLog } from "./verbose";

/**
 * Determine if attachments should be included based on query analysis.
 */
function shouldIncludeAttachments(question: string): boolean {
  const questionLower = question.toLowerCase();

  // Keywords that suggest attachments are relevant
  const attachmentKeywords = [
    "attachment",
    "attached",
    "file",
    "document",
    "spreadsheet",
    "excel",
    "xlsx",
    "csv",
    "pdf",
    "invoice",
    "receipt",
    "statement",
    "report",
    "quote",
    "quotation",
    "line item",
    "line items",
    "breakdown",
    "details",
    "data",
    "table",
    "funds request",
    "payment",
    "bill",
    "billing",
    "expense",
    "cost",
    "price",
    "contract",
    "agreement",
    "proposal",
    "estimate",
  ];

  return attachmentKeywords.some((keyword) => questionLower.includes(keyword));
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
    return {
      include: false,
      reason: `attachment too large (${(att.size / 1024 / 1024).toFixed(1)} MB)`,
    };
  }

  // Skip images, videos, audio unless they're small (likely thumbnails/icons)
  const nonTextTypes = ["image/", "video/", "audio/"];
  if (nonTextTypes.some((type) => att.mime_type.startsWith(type)) && att.size > 500 * 1024) {
    return {
      include: false,
      reason: `non-text attachment type (${att.mime_type}), size ${(att.size / 1024).toFixed(0)} KB`,
    };
  }

  // If we already have a lot of attachment content, skip larger attachments
  if (totalAttachmentChars > MAX_TOTAL_ATTACHMENT_CHARS / 2 && att.size > 100 * 1024) {
    return { include: false, reason: "total attachment content limit approaching" };
  }

  // Check extracted text size if already extracted
  if (att.extracted_text && att.extracted_text.length > MAX_EXTRACTED_TEXT_CHARS) {
    return {
      include: false,
      reason: `extracted text too long (${att.extracted_text.length} chars)`,
    };
  }

  return { include: true };
}

/**
 * Determine which tier a message belongs to based on relevance.
 * Tier 1: subject contains pattern term OR strong FTS5 match (rank < -0.5)
 * Tier 2: any FTS5 match (has snippet)
 * Tier 3: filter-only match (no keyword hit)
 */
function getMessageTier(msg: SearchResult, plan: SearchPlan): 1 | 2 | 3 {
  const subjectLower = msg.subject.toLowerCase();

  // Tier 1: subject contains a pattern term
  const subjectMatchesPattern = plan.patterns.some((pattern) =>
    subjectLower.includes(pattern.toLowerCase())
  );

  // Tier 1: strong FTS5 match (rank < -0.5 means very relevant)
  const strongMatch = msg.rank !== undefined && msg.rank < -0.5;

  if (subjectMatchesPattern || strongMatch) {
    return 1;
  }

  // Tier 2: has snippet (means FTS5 found a match)
  if (msg.snippet && msg.snippet.trim().length > 0) {
    return 2;
  }

  // Tier 3: filter-only match (no snippet, no rank)
  return 3;
}

/**
 * Assemble tiered context from search results.
 * Tier 1: up to 3000 chars (subject match or strong FTS5 match)
 * Tier 2: up to 800 chars (any FTS5 match)
 * Tier 3: snippet only (~150 chars) (filter-only match)
 *
 * Hard cap: 80k chars total. Fills Tier 1 first, then Tier 2, then Tier 3 until cap.
 */
export async function assembleContext(
  hits: SearchResult[],
  plan: SearchPlan,
  db: SqliteDatabase,
  opts?: { question?: string }
): Promise<string> {
  const question = opts?.question ?? "";
  const MAX_CONTEXT_CHARS = 80000; // 80k hard cap
  const TIER_1_CHARS = 3000;
  const TIER_2_CHARS = 800;
  const TIER_3_CHARS = 150; // snippet only

  // Sort hits by tier (1 first, then 2, then 3)
  const hitsWithTier = hits.map((msg) => ({
    msg,
    tier: getMessageTier(msg, plan),
  }));
  hitsWithTier.sort((a, b) => a.tier - b.tier);

  const parts: string[] = [];
  let totalChars = 0;
  let tier1Count = 0;
  let tier2Count = 0;
  let tier3Count = 0;

  // Fetch full message data for messages we'll include
  const messageIdsToFetch = hitsWithTier.map((h) => h.msg.messageId);
  if (messageIdsToFetch.length === 0) {
    verboseLog(`[assemble] no hits to assemble\n`);
    return "";
  }

  const placeholders = messageIdsToFetch.map(() => "?").join(",");
  const messages = db
    .prepare(`SELECT * FROM messages WHERE message_id IN (${placeholders})`)
    .all(...messageIdsToFetch) as any[];

  const messageMap = new Map<string, any>();
  for (const msg of messages) {
    messageMap.set(msg.message_id, msg);
  }

  verboseLog(`[assemble] assembling context from ${hitsWithTier.length} hits\n`);

  for (const { msg, tier } of hitsWithTier) {
    if (totalChars >= MAX_CONTEXT_CHARS) {
      verboseLog(`[assemble] reached context cap (${totalChars} chars), stopping\n`);
      break;
    }

    const dbMessage = messageMap.get(msg.messageId);
    if (!dbMessage) {
      continue; // message not found in DB (shouldn't happen)
    }

    // Determine body length based on tier
    let maxBodyChars: number;
    if (tier === 1) {
      maxBodyChars = TIER_1_CHARS;
      tier1Count++;
    } else if (tier === 2) {
      maxBodyChars = TIER_2_CHARS;
      tier2Count++;
    } else {
      maxBodyChars = TIER_3_CHARS; // snippet only
      tier3Count++;
    }

    // Format message
    const shaped = await formatMessageForOutput(dbMessage, false, db);
    const lean = toLeanMessage(shaped as any, maxBodyChars);
    const content = lean.content as { markdown?: string } | undefined;
    const markdown = content?.markdown || "";

    // Fetch attachments if relevant
    let attachmentContent = "";
    let totalAttachmentChars = 0;

    const shouldProcessAttachments = shouldIncludeAttachments(question);

    if (shouldProcessAttachments) {
      const attachments = db
        .prepare(
          `SELECT id, filename, mime_type, size, stored_path, extracted_text FROM attachments WHERE message_id = ? ORDER BY filename`
        )
        .all(msg.messageId) as Array<{
        id: number;
        filename: string;
        mime_type: string;
        size: number;
        stored_path: string;
        extracted_text: string | null;
      }>;

      if (attachments.length > 0) {
        const attachmentParts: string[] = [];
        for (const att of attachments) {
          const shouldInclude = shouldIncludeAttachment(att, totalAttachmentChars);
          if (!shouldInclude.include) {
            verboseLog(`[assemble] skipping attachment ${att.filename}: ${shouldInclude.reason}\n`);
            continue;
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
                verboseLog(
                  `[assemble] extracted text too long (${extractedText.length} chars), truncating\n`
                );
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
            attachmentParts.push(
              `\n--- Attachment: ${att.filename} (${att.mime_type}) ---\n[Attachment not extracted]`
            );
          }
        }
        attachmentContent = attachmentParts.join("\n");
      }
    }

    const messageText = `---\nFrom: ${lean.from_address}${lean.from_name ? ` (${lean.from_name})` : ""}\nSubject: ${lean.subject}\nDate: ${lean.date}${markdown ? `\n${markdown}` : ""}${attachmentContent}`;

    const messageChars = messageText.length;
    if (totalChars + messageChars > MAX_CONTEXT_CHARS) {
      // Truncate this message if it would exceed cap
      const remaining = MAX_CONTEXT_CHARS - totalChars;
      if (remaining > 100) {
        // Only include if we have at least 100 chars left
        parts.push(messageText.slice(0, remaining) + "\n[... truncated ...]");
        totalChars = MAX_CONTEXT_CHARS;
      }
      break;
    }

    parts.push(messageText);
    totalChars += messageChars;
  }

  verboseLog(
    `[assemble] assembled ${totalChars} chars from ${tier1Count} tier-1, ${tier2Count} tier-2, ${tier3Count} tier-3 messages\n`
  );

  return parts.join("\n\n");
}
