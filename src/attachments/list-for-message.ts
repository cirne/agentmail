import type { SqliteDatabase } from "~/db";

/**
 * Canonical rule: attachments for a message are ordered by `filename` (ascending).
 * That order defines the 1-based `index` for `zmail attachment read <message_id> <index>`,
 * `zmail attachment list`, and MCP `list_attachments`.
 */
export type AttachmentRowByFilename = {
  id: number;
  message_id: string;
  filename: string;
  mime_type: string;
  size: number;
  stored_path: string;
  extracted_text: string | null;
};

/** Slim shape with 1-based index in filename order (search / refresh / inbox JSON). */
export type AttachmentIndexedByFilename = {
  id: number;
  filename: string;
  mimeType: string;
  size: number;
  extracted: boolean;
  index: number;
};

/** Full rows for one message, `ORDER BY filename`. */
export async function listAttachmentsForMessage(
  db: SqliteDatabase,
  messageId: string
): Promise<AttachmentRowByFilename[]> {
  return (await (
    await db.prepare(
      /* sql */ `
      SELECT id, message_id, filename, mime_type, size, stored_path, extracted_text
      FROM attachments
      WHERE message_id = ?
      ORDER BY filename`
    )
  ).all(messageId)) as AttachmentRowByFilename[];
}

/**
 * Batch-load attachment metadata. Per message, same filename order and 1-based `index` as
 * {@link listAttachmentsForMessage}.
 */
export async function indexAttachmentsByMessageId(
  db: SqliteDatabase,
  messageIds: string[]
): Promise<Map<string, AttachmentIndexedByFilename[]>> {
  const byMessage = new Map<string, AttachmentIndexedByFilename[]>();
  if (messageIds.length === 0) return byMessage;

  const placeholders = messageIds.map(() => "?").join(",");
  const rows = (await (
    await db.prepare(
      /* sql */ `
      SELECT message_id AS messageId, id, filename, mime_type AS mimeType, size,
             CASE WHEN extracted_text IS NOT NULL AND LENGTH(TRIM(extracted_text)) > 0 THEN 1 ELSE 0 END AS extracted
      FROM attachments
      WHERE message_id IN (${placeholders})
      ORDER BY message_id, filename`
    )
  ).all(...messageIds)) as Array<{
    messageId: string;
    id: number;
    filename: string;
    mimeType: string;
    size: number;
    extracted: number;
  }>;

  for (const row of rows) {
    const list = byMessage.get(row.messageId) ?? [];
    list.push({
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      size: row.size,
      extracted: row.extracted === 1,
      index: list.length + 1,
    });
    byMessage.set(row.messageId, list);
  }
  return byMessage;
}
