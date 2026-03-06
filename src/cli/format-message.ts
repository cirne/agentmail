/**
 * LLM-friendly message output formatter for `zmail message`.
 * Headers one per line, optional content-origin hint (only when converted from rich format), then body.
 */

export interface MessageRowLike {
  message_id: string;
  thread_id: string;
  date: string;
  from_address: string;
  from_name: string | null;
  to_addresses: string;
  cc_addresses: string;
  subject: string;
}

export interface ShapedContent {
  content?: {
    source?: string;
    markdown?: string;
    format?: string;
    eml?: string | null;
  };
  attachments?: Array<{
    id: number;
    filename: string;
    mimeType: string;
    size: number;
    extracted: boolean;
  }>;
}

/**
 * Produces LLM-friendly text: headers (one per line), optional "Content (original: ...)" only when
 * body was converted from a rich format (e.g. HTML) or is raw EML, then "---" and the body.
 */
export function formatMessageLlmFriendly(
  message: MessageRowLike,
  shaped: Record<string, unknown> & ShapedContent
): string {
  const lines: string[] = [];
  lines.push(`Message-ID: ${message.message_id}`);
  lines.push(`Thread-ID: ${message.thread_id}`);
  lines.push(`Date: ${message.date}`);
  lines.push(`From: ${message.from_name ? `${message.from_name} <${message.from_address}>` : message.from_address}`);
  const to = String(message.to_addresses ?? "").trim();
  if (to && to !== "[]") lines.push(`To: ${to}`);
  const cc = String(message.cc_addresses ?? "").trim();
  if (cc && cc !== "[]") lines.push(`Cc: ${cc}`);
  lines.push(`Subject: ${message.subject}`);

  const content = shaped.content && typeof shaped.content === "object" ? shaped.content : {};
  const isRaw = content.format === "raw" && "eml" in content;
  const source = "source" in content ? String(content.source) : "unknown";

  // Add attachment summary before body
  const attachments = Array.isArray(shaped.attachments) ? shaped.attachments : [];
  if (attachments.length > 0) {
    lines.push("");
    const extractedCount = attachments.filter((a) => a.extracted).length;
    const attachmentList = attachments.map((a) => {
      const extractedMark = a.extracted ? " [extracted]" : "";
      return `  - ${a.filename} (${a.mimeType})${extractedMark}`;
    }).join("\n");
    lines.push(`Attachments (${attachments.length}${extractedCount > 0 ? `, ${extractedCount} extracted` : ""}):`);
    lines.push(attachmentList);
    lines.push("");
    lines.push(`To list attachments: zmail attachment list "${message.message_id}"`);
    lines.push(`To read attachment: zmail attachment read "${message.message_id}" <index>|<filename>`);
  }

  let body: string;
  if (isRaw && content.eml != null) {
    body = String(content.eml);
    lines.push("");
    lines.push("Content (original: raw EML)");
    lines.push("---");
    lines.push(body);
  } else {
    body =
      "markdown" in content && content.markdown != null ? String(content.markdown) : "";
    body = body.trim() || "(no body)";
    lines.push("");
    if (source === "html") {
      lines.push("Content (original: HTML)");
      lines.push("---");
    } else {
      lines.push("---");
    }
    lines.push(body);
  }
  return lines.join("\n");
}
