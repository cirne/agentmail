/** Attachment line items for refresh / inbox `newMail` (order matches `zmail attachment list`). */
export type RefreshPreviewAttachment = {
  id: number;
  filename: string;
  mimeType: string;
  /** 1-based index for `zmail attachment read <message_id> <index>` */
  index: number;
};

/** One row in refresh / inbox JSON `newMail` (optional `note` for LLM inbox). */
export type RefreshPreviewRow = {
  messageId: string;
  date: string;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  snippet: string;
  note?: string;
  /** Present when the message has attachments (filenames + indices for read/list). */
  attachments?: RefreshPreviewAttachment[];
};
