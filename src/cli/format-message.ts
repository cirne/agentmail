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
