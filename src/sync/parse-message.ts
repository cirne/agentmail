import PostalMime from "postal-mime";
import { htmlToMarkdown } from "~/lib/content-normalize";

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  content: Buffer;
}

export interface ParsedMessage {
  messageId: string;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string;
  date: string; // ISO
  bodyText: string;
  bodyHtml: string | null;
  attachments: ParsedAttachment[];
}

export async function parseRawMessage(raw: Buffer): Promise<ParsedMessage> {
  // postal-mime expects an ArrayBuffer. In Node, Buffer is a Uint8Array view; .buffer
  // may be shared and have a non-zero byteOffset. Copy to a plain ArrayBuffer so
  // PostalMime receives exactly the message bytes (and to satisfy ArrayBuffer type).
  const copy = new Uint8Array(raw.byteLength);
  copy.set(raw);
  const email = await PostalMime.parse(copy.buffer);

  const messageId = email.messageId ?? `<unknown-${Date.now()}@local>`;

  // Reject obviously invalid dates (malformed headers, far-future typos). Store sane range only.
  const MIN_DATE_MS = new Date("1980-01-01T00:00:00.000Z").getTime();
  const MAX_DATE_MS = Date.now() + 24 * 60 * 60 * 1000; // now + 1 day (allow small clock skew)
  let date: string;
  if (email.date) {
    const d = new Date(email.date);
    const t = d.getTime();
    if (Number.isNaN(t) || t < MIN_DATE_MS || t > MAX_DATE_MS) {
      date = new Date().toISOString();
    } else {
      date = d.toISOString();
    }
  } else {
    date = new Date().toISOString();
  }

  // Extract attachments, filtering out inline images (disposition: "inline" or related: true)
  // These are embedded in HTML body, not user-facing attachments
  const attachments: ParsedAttachment[] = [];
  for (const att of email.attachments ?? []) {
    // Skip inline attachments (embedded images in HTML)
    if (att.disposition === "inline" || att.related) {
      continue;
    }

    // Skip if no filename (unlikely but handle gracefully)
    if (!att.filename) {
      continue;
    }

    // Convert content to Buffer
    let content: Buffer;
    if (att.content instanceof ArrayBuffer) {
      content = Buffer.from(att.content);
    } else if (typeof att.content === "string") {
      // Handle base64 or other encodings
      if (att.encoding === "base64") {
        content = Buffer.from(att.content, "base64");
      } else {
        content = Buffer.from(att.content, "utf8");
      }
    } else {
      continue; // Skip if content format is unexpected
    }

    attachments.push({
      filename: att.filename,
      mimeType: att.mimeType,
      size: content.length,
      content,
    });
  }

  // Extract body text: prefer plain text, fall back to converting HTML to markdown
  let bodyText = email.text ?? "";
  if (!bodyText && email.html) {
    // For HTML-only emails, convert HTML to markdown for storage
    bodyText = htmlToMarkdown(email.html);
  }

  return {
    messageId,
    fromAddress: email.from?.address ?? "",
    fromName: email.from?.name || null,
    toAddresses: (email.to ?? []).map((a) => a.address).filter((a): a is string => Boolean(a)),
    ccAddresses: (email.cc ?? []).map((a) => a.address).filter((a): a is string => Boolean(a)),
    subject: email.subject ?? "",
    date,
    bodyText,
    bodyHtml: email.html ?? null,
    attachments,
  };
}
