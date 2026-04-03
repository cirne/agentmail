import PostalMime from "postal-mime";
import { htmlToMarkdown } from "~/lib/content-normalize";

/** When MIME parts have `Content-Disposition: attachment` but no filename/name (BUG-036). */
function fallbackAttachmentFilename(mimeType: string, index: number): string {
  const sub = (mimeType.split("/")[1] || "octet-stream").toLowerCase();
  const ext =
    sub === "pdf"
      ? "pdf"
      : sub === "zip"
        ? "zip"
        : sub === "gzip"
          ? "gz"
          : sub === "msword"
            ? "doc"
            : sub === "vnd.openxmlformats-officedocument.wordprocessingml.document"
              ? "docx"
              : sub === "vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                ? "xlsx"
                : sub === "vnd.openxmlformats-officedocument.presentationml.presentation"
                  ? "pptx"
                  : sub === "csv"
                    ? "csv"
                    : sub === "plain"
                      ? "txt"
                      : sub === "html"
                        ? "html"
                        : sub === "octet-stream"
                          ? "bin"
                          : /^[a-z0-9.-]{1,32}$/i.test(sub)
                            ? sub.replace(/^\.+|\.+$/g, "") || "bin"
                            : "bin";
  return `attachment-${index + 1}.${ext}`;
}

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
  isNoise: boolean;
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
  // Note: postal-mime sets related: true on some attachments in multipart structures, even when
  // disposition: "attachment". We preserve those attachments (they're real user-facing files).
  const attachments: ParsedAttachment[] = [];
  for (const att of email.attachments ?? []) {
    // Skip inline attachments (embedded images in HTML)
    // But preserve attachments with explicit disposition: "attachment" even if related: true
    if (att.disposition === "inline" || (att.related && att.disposition !== "attachment")) {
      continue;
    }

    // Prefer MIME filename; if missing (some clients omit it on attachment parts), still index the
    // bytes so agents can read — same as Rust `collect_attachments` fallback (BUG-036).
    const filename =
      att.filename ||
      fallbackAttachmentFilename(att.mimeType || "application/octet-stream", attachments.length);

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
      filename,
      mimeType: att.mimeType || "application/octet-stream",
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

  // Detect noise signals from headers (promotional, bulk, mailing lists)
  // postal-mime exposes headers as array of { key: string (lowercase), value: string }
  // 
  // Noise classification strategy:
  // - List-Unsubscribe alone: NOT noise (too common in transactional email from large senders)
  // - List-Id: noise (genuine mailing list identifier, not used by transactional senders)
  // - Precedence: bulk/list/junk/auto: noise
  // - X-Auto-Response-Suppress: noise
  // - List-Unsubscribe + List-Id together: noise (mailing list with unsubscribe link)
  let isNoise = false;
  let hasListUnsubscribe = false;
  let hasListId = false;
  
  if (email.headers && Array.isArray(email.headers)) {
    for (const header of email.headers) {
      const key = header.key?.toLowerCase() ?? "";
      const value = (header.value ?? "").trim();
      
      if (!value) continue;
      
      if (key === "list-unsubscribe") {
        hasListUnsubscribe = true;
        continue; // Don't mark as noise yet - check for List-Id combo
      }
      
      if (key === "list-id") {
        hasListId = true;
        // List-Id alone is a strong signal for mailing lists
        isNoise = true;
        break;
      }
      
      // Precedence header with bulk/list/junk/auto values
      if (key === "precedence") {
        const precedenceLower = value.toLowerCase();
        if (precedenceLower === "bulk" || precedenceLower === "list" || 
            precedenceLower === "junk" || precedenceLower === "auto") {
          isNoise = true;
          break;
        }
      }
      
      // X-Auto-Response-Suppress header (indicates automated/bulk mail)
      if (key === "x-auto-response-suppress") {
        isNoise = true;
        break;
      }
    }
    
    // If we have both List-Unsubscribe and List-Id, it's a mailing list (not transactional)
    if (!isNoise && hasListUnsubscribe && hasListId) {
      isNoise = true;
    }
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
    isNoise,
  };
}
