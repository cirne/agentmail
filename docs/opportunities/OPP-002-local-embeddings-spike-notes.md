# OPP-002 Spike Notes — Local Embeddings (transformers.js + BGE)

Date: 2026-03-05

## Goal

Get **locally-hosted embeddings** working end-to-end (no OpenAI dependency) using the model proposed in OPP-002: `Xenova/bge-small-en-v1.5` (384 dims), via `@huggingface/transformers` (transformers.js).

## What’s implemented

- **Local embedding provider (BGE)**
  - `embedText(query)` uses the BGE retrieval **query prefix**:
    - `Represent this sentence for searching relevant passages: <query>`
  - `embedBatch(passages[])` encodes **documents/passages** without prefix (used for index-time emails).
  - Model: `Xenova/bge-small-en-v1.5`, dtype: `q8` (fast CPU).
  - Lazy-loaded pipeline (first call downloads/loads model, subsequent calls are fast).
  - Code: `src/search/embeddings.ts`

- **Indexing no longer requires `OPENAI_API_KEY`**
  - `OPENAI_API_KEY` is now optional in config.
  - Indexer no longer early-exits when `OPENAI_API_KEY` is missing.
  - Code: `src/lib/config.ts`, `src/search/indexing.ts`

- **Search robustness for early prototyping**
  - If LanceDB vectors are missing, semantic search is skipped without computing query embeddings.
  - If LanceDB vectors exist but were built with a **different embedding dimension** (e.g. old 1536-dim OpenAI vectors), semantic search **degrades gracefully** to “no semantic results” instead of 500’ing the web route / throwing in tests.
  - Code: `src/search/vectors.ts`, `src/search/index.ts`

- **Hermetic web tests**
  - Web route tests run with an in-memory SQLite DB so local dev `./data/zmail.db` can’t break CI/test runs.
  - Code: `src/db/index.ts`, `src/web/web.test.ts`

## Dependencies added

- `@huggingface/transformers`
  - Pulled in `onnxruntime-node` for CPU inference.
  - `package.json` includes `trustedDependencies` for `onnxruntime-node` and `protobufjs` so Bun can run required postinstall scripts during `bun install`.

## Smoke-checks run during spike

- Verified embeddings execute under Bun and return **384-dim vectors**:
  - `embedText("hello world") → 384`
  - `embedBatch(["doc one", "doc two"]) → 2 x 384`

## Issues encountered & learnings

- **Bun install lifecycle scripts**
  - Bun initially blocked postinstalls for `onnxruntime-node` and `protobufjs`.
  - Adding them to `trustedDependencies` ensures `bun install` can run the needed scripts without manual intervention.

- **Existing local vector store incompatibility**
  - If a developer has a previously-created LanceDB table built with OpenAI embeddings (1536 dims), querying with BGE (384 dims) throws a LanceDB error.
  - For the spike, semantic search now treats this as “no semantic results” instead of crashing.
  - For a real rollout, we likely want a clearer UX (detect + show “reindex required”).

- **Context length mismatch vs OpenAI**
  - BGE models have much shorter context than OpenAI embeddings; our truncation is currently a crude char cap.
  - For higher-quality index-time embeddings on long emails, we probably want chunking (body → N chunks → pooled embedding) or a stricter token-based cap.

## How to use (local embeddings)

- Ensure vectors are rebuilt for the new embedding space:
  - Delete existing vectors dir: `rm -rf data/vectors/`
  - Reset message embedding state if needed (or full data reset): `rm -rf data/` then re-sync

## Next steps (if we keep this direction)

- Add an explicit “embedding provider + expected dimension” marker in SQLite/LanceDB and refuse to use mismatched vector stores.
- Add chunking for long email bodies (token-based) for better index-time quality.
- Decide whether to keep an OpenAI provider behind a switch or remove it entirely for Phase 2.

