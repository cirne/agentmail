# Product Opportunities

Improvement ideas discovered through real usage. Each entry captures the problem, a concrete example, and a proposed direction.

See [VISION.md](./VISION.md) for product vision, [ARCHITECTURE.md](./ARCHITECTURE.md) for technical decisions.

---

| ID | Title | Summary |
|---|---|---|
| [OPP-001](opportunities/OPP-001-personalization.md) | Personalization — User Context for Search | Let users define aliases and context so queries like "ranch" match emails that use project names like "Son Story." |
| [OPP-002](opportunities/OPP-002-local-embeddings.md) | Local Embeddings — Eliminate Search Latency and OpenAI Dependency | Replace OpenAI API embeddings with a local `bge-small-en-v1.5` model via transformers.js. Cuts search latency from ~200ms to ~10ms, removes the `OPENAI_API_KEY` requirement. |
| [OPP-003](opportunities/OPP-003-cli-search-interface.md) | CLI Search Interface — Header-First Results + Selective Hydration | Optimize agent workflows with header-first defaults, mode controls (`auto|fts|semantic|hybrid`), payload-safe pagination, and explicit shortlist→hydrate retrieval. |
