import removeMd from "remove-markdown";

/**
 * Convert draft body (often Markdown) to plain text for SMTP text/plain.
 * Applied only on the send path; on-disk drafts stay unchanged.
 */
export function draftMarkdownToPlainText(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n");
  const plain = removeMd(normalized, {
    gfm: true,
    stripListLeaders: true,
    useImgAltText: true,
  });
  return plain.replace(/\n{3,}/g, "\n\n").trim();
}
