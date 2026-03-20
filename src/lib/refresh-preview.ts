/** One row in refresh / inbox JSON `newMail` (optional `note` for LLM inbox). */
export type RefreshPreviewRow = {
  messageId: string;
  date: string;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  snippet: string;
  note?: string;
};
