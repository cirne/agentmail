/**
 * When `get_messages` is called without `detail` and the batch is larger than this,
 * all messages are returned as `detail: "summary"` (slim) to protect context size.
 * Pass `detail: "full"` explicitly to force full bodies for any batch size.
 */
export const GET_MESSAGES_AUTO_SUMMARY_THRESHOLD = 5;

export type GetMessagesDetailParam = "full" | "summary" | "raw" | undefined;

/**
 * Resolves `detail` for shapeShapedToOutput: `"summary"` or undefined (= full lean body).
 * Raw responses use useRaw and ignore this.
 */
export function resolveGetMessagesShapeDetail(
  batchSize: number,
  detail: GetMessagesDetailParam,
  raw: boolean
): "summary" | undefined {
  if (raw || detail === "raw") return undefined;
  if (detail === "summary") return "summary";
  if (detail === "full") return undefined;
  return batchSize > GET_MESSAGES_AUTO_SUMMARY_THRESHOLD ? "summary" : undefined;
}
