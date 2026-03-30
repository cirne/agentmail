# BUG-026: `who` — English-Only Nickname Map, Rust Parity Gap, No Multi-Term Query Contract

**Status:** Open. **Created:** 2026-03-30. **Tags:** who, search, rust-port, agent-intuitive, i18n

**Design lens:** [Agent-first](../VISION.md) — `zmail who` should be fast by default and still behave predictably for humans, scripts, and LLM agents. Today identity merging and query matching depend on a large, hand-maintained English nickname dictionary in code, and the Rust port ships only a small subset. Agents have no first-class way to pass multiple name variants in one call (e.g. OR / repeated terms), so documentation that implies patterns like `tom|thomas` would be wrong unless we add explicit support.

---

## Summary

1. **Nickname normalization is English-centric and embedded in source.** [`node/src/search/nicknames.ts`](../../node/src/search/nicknames.ts) maps hundreds of diminutives to canonical first names for (a) cluster merge keys in `who-dynamic` / `clusterIdentities`, and (b) tie-breaking / fuzzy signals. It improves merges like "Bob Jones" vs "Robert Jones" for common US/UK names but is wrong or empty for many locales, cultures, and ambiguous short forms (e.g. "Pat" → Patricia vs Patrick). Maintaining the list in code is brittle.

2. **Rust `who` uses a documented subset only.** [`src/search/nicknames.rs`](../../src/search/nicknames.rs) states it mirrors a subset of the TypeScript map. Query-side phonetic/fuzzy matching after `canonical_first_name` therefore diverges from Node for most entries. Until cutover, this is a **parity gap** for the same CLI surface ([ADR-025](ARCHITECTURE.md#adr-025-rust-port--parallel-implementation-pre-cutover)).

3. **No multi-term / OR query for `who`.** The query string is a single phrase used as substring (and related scoring). Passing `tom|thomas` does **not** mean OR; it searches for that literal substring. Agents that want variants must run **multiple** `who` invocations and merge results, or we need an explicit API (e.g. repeated `--query`, comma-separated terms, or documented JSON) and MCP parity.

---

## Impact

- **Accuracy:** False negatives (variants not in the map) and wrong merges where the map picks an inappropriate canonical form.
- **Maintainability:** Every nickname edge case becomes a code change in two places if Rust is meant to match Node.
- **Agent-intuitive:** Skills or host prompts that suggest pipe/OR-style queries without documenting actual behavior will mislead the model.

---

## Fix options (non-exclusive)

1. **Data, not code:** Move the nickname table to a versioned JSON (or similar) loaded at runtime; single artifact shared or generated for Rust/TS to avoid drift; optional user override path under `ZMAIL_HOME`.
2. **Shrink heuristics:** Rely more on existing phonetic + edit-distance matching and narrower nickname coverage; measure regressions on `who` tests and real mailboxes.
3. **Explicit multi-term `who`:** Add a documented contract (`--terms` or multiple flags), implement in Node + Rust + MCP + tests; update [AGENTS.md](../../AGENTS.md), [docs/MCP.md](../MCP.md), and the publishable skill if CLI/MCP change.
4. **Agent layer (complement, not replacement):** Document in [`skills/zmail/SKILL.md`](../../skills/zmail/SKILL.md) that agents may call `who` several times with variants and dedupe by `primaryAddress` until (3) exists.
5. **Rust parity:** Either expand Rust’s map to match Node, generate both from one source, or document intentional divergence until cutover.

---

## References

- Node: [`node/src/search/nicknames.ts`](../../node/src/search/nicknames.ts), [`node/src/search/who-dynamic.ts`](../../node/src/search/who-dynamic.ts) (cluster merge by `canonicalFirst:last`), [`node/src/search/cluster.ts`](../../node/src/search/cluster.ts).
- Rust: [`src/search/nicknames.rs`](../../src/search/nicknames.rs), [`src/search/who.rs`](../../src/search/who.rs) (`matches_query` + canonical first name).
- Related prior `who` identity bugs (fixed): [BUG-011](archive/BUG-011-who-dartmouth-not-merged.md), [BUG-012](archive/BUG-012-who-min-sent-splits-identity.md), etc.

---

## Acceptance criteria (when closing)

- [ ] Chosen direction documented (data file vs generated vs reduced heuristics).
- [ ] Node and Rust behavior aligned **or** differences explicitly documented in [README.md](../../README.md) / ADR-025 notes.
- [ ] If multi-term `who` is added: CLI, MCP, tests, and agent-facing docs updated; param-sync tests pass.
- [ ] Publishable skill / AGENTS guidance matches actual query syntax (no misleading `|` OR unless implemented).
