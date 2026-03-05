/**
 * Bun Worker for parallel indexing — pure API executor.
 * Does NOT touch SQLite. Receives message data from orchestrator via postMessage,
 * calls OpenAI for embeddings + LanceDB for upsert, sends results back.
 */

import { logger } from "~/lib/logger";
import { embedBatch, prepareTextForEmbedding } from "./embeddings";
import { addEmbeddingsBatch, type EmbeddingRow } from "./vectors";

export interface WorkerBatchRequest {
  type: "batch";
  messages: Array<{
    message_id: string;
    subject: string;
    body_text: string;
    from_address: string;
    date: string;
  }>;
}

export interface WorkerBatchResponse {
  type: "batch_done";
  results: Array<{
    message_id: string;
    success: boolean;
    error?: string;
  }>;
}

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data as WorkerBatchRequest;

  if (msg.type === "batch") {
    const texts = msg.messages.map((m) =>
      prepareTextForEmbedding(m.subject, m.body_text),
    );

    try {
      const embeddings = await embedBatch(texts);

      const rows: EmbeddingRow[] = msg.messages.map((m, i) => ({
        messageId: m.message_id,
        embedding: embeddings[i],
        subject: m.subject,
        fromAddress: m.from_address,
        date: m.date,
      }));

      await addEmbeddingsBatch(rows);

      const results: WorkerBatchResponse["results"] = msg.messages.map(
        (m) => ({ message_id: m.message_id, success: true }),
      );
      postMessage({ type: "batch_done", results } as WorkerBatchResponse);
    } catch (err) {
      logger.error("Embedding batch failed", { error: String(err) });
      const results: WorkerBatchResponse["results"] = msg.messages.map(
        (m) => ({
          message_id: m.message_id,
          success: false,
          error: String(err),
        }),
      );
      postMessage({ type: "batch_done", results } as WorkerBatchResponse);
    }
  }
};
