# OPP-002: Local Embeddings — Eliminate Search Latency and OpenAI Dependency

**Archived:** 2026-03-26 — **superseded / no longer relevant** for the current product: search is FTS-only ([ARCHITECTURE.md](../../ARCHITECTURE.md)); the LanceDB + embedding pipeline was removed ([OPP-019](OPP-019-fts-first-retire-semantic-default.md)). Revisit only if vector / semantic retrieval is reintroduced as an opt-in path.

**Problem (historical):** The primary bottleneck for semantic search is generating the query embedding. Every search incurs a network round-trip to the OpenAI API (100–300ms) before the vector lookup even begins. This is wasteful for the search-time case: query strings are short (typically < 20 tokens), so the actual compute is trivial — we're paying for the round-trip, not the work.

Additionally, requiring `OPENAI_API_KEY` is a friction point for open-source users who want full privacy or offline operation.

**Proposed direction:** Switch to a locally-running embedding model for both search-time and index-time embedding generation.

## Recommended model: `bge-small-en-v1.5` (BAAI)

| Property | Value |
|---|---|
| Dimensions | 384 |
| Parameters | 33M |
| MTEB retrieval score | ~62 (comparable to `text-embedding-3-small`) |
| CPU latency (short query) | ~5–10ms (vs. 100–300ms API round-trip) |
| CPU latency (full email, index time) | ~50–150ms |

BGE models are explicitly fine-tuned for **retrieval** tasks (not just general similarity), which is a better fit for search than general-purpose embedding models. Smaller dimensions (384 vs 1536) also means faster ANN search in LanceDB and less storage.

For asymmetric retrieval (query vs document encoding), use BGE's built-in prefixes:
- Queries: `"Represent this sentence for searching relevant passages: <query>"`  
  (or short form: `search_query: <query>`)
- Index-time emails: no prefix needed (BGE encodes passages without prefix)

## Runtime: `@huggingface/transformers` (transformers.js)

```typescript
import { pipeline } from "@huggingface/transformers";

const extractor = await pipeline(
  "feature-extraction",
  "Xenova/bge-small-en-v1.5",
  { dtype: "q8" }, // 8-bit quantized: ~2x faster on CPU, negligible quality loss
);

export async function embedText(text: string): Promise<number[]> {
  const output = await extractor(`Represent this sentence for searching relevant passages: ${text}`, {
    pooling: "mean",
    normalize: true,
  });
  return Array.from(output.data as Float32Array);
}
```

- Pure TypeScript/ONNX — no external process, no system dependencies
- Model downloaded from HuggingFace Hub on first use, then cached to `~/.cache/huggingface/`
- Cold start (model load): ~1–3s once per process, not per search
- Works inside a compiled Bun binary (ONNX runtime bundles cleanly)
- `q8` quantization: ~2x faster on CPU with negligible accuracy loss; `q4` available for even faster but slightly lower quality

## Alternative runtime: Ollama

If transformers.js has Bun binary compatibility issues, fall back to Ollama:

```typescript
const res = await fetch("http://localhost:11434/api/embeddings", {
  method: "POST",
  body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
});
```

- Already mentioned in ARCHITECTURE.md (ADR-006) as the Ollama path
- `nomic-embed-text` is the recommended model for Ollama (768 dims, MTEB ~62)
- ~20–80ms local round-trip — no internet, but requires Ollama running
- Adds a hard runtime dependency; not suitable for the compiled binary path

## Implementation plan

1. **Add `@huggingface/transformers` dependency.**
2. **Replace `src/search/embeddings.ts`** — swap `embedText` and `embedBatch` implementations. Keep the same function signatures; no callers need to change.
3. **Update `src/search/indexing.ts`** — use the BGE document encoding (no prefix) for index-time calls.
4. **Re-index all emails** — existing LanceDB embeddings are in a different vector space (1536-dim OpenAI) and are incompatible. Drop and rebuild: `rm -rf ~/.zmail/data/vectors/` then run `zmail sync` or a backfill command. The SQLite `embedding_state` column will drive re-indexing automatically if rows are reset to `pending`.
5. **Remove `OPENAI_API_KEY` as a hard requirement** — it should only be needed if the user has opted into OpenAI embeddings or uses other OpenAI features (e.g. vision API for attachment OCR).
6. **Update `ARCHITECTURE.md` ADR-006** — record the decision to switch default embedding to local model.
7. **Update setup flow** — `OPENAI_API_KEY` becomes optional in interactive setup, document what it's still used for.

## What stays the same

- LanceDB as the vector store
- RRF hybrid search (FTS5 + semantic)
- `searchVectors()`, `addEmbeddingsBatch()` in `src/search/vectors.ts` — no changes needed
- The `embedding_state` queue in SQLite

## Open questions

- Does `@huggingface/transformers` ONNX runtime bundle correctly into a `bun build --compile` binary? Needs a quick spike to verify before committing to this path. Fall back to Ollama if not.
- Cache model in `ZMAIL_HOME/data` (or similar) instead of `~/.cache` so it travels with the deployment volume? Or document the HuggingFace cache location so users know where it lives.
- Should OpenAI remain as a configurable option (env var `EMBEDDING_PROVIDER=openai|local`) for users who prefer it?
