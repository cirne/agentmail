# BUG-032: `zmail search` should allow filter-only queries without a dummy positional query

**Status:** Open. **Created:** 2026-03-31. **Tags:** search, cli, ux, agent-first

**Design lens:** [Agent-first](../VISION.md) — agents naturally start with filter-only retrieval such as "emails from X" or "mail before Y". Requiring a throwaway positional `<QUERY>` forces an avoidable retry and makes the most common search pattern less intuitive than the underlying data model.

---

## Summary

- **Observed:** `zmail search --from "stiller" --limit 10` fails because `<QUERY>` is required.
- **Expected:** When one or more filter flags already define a valid search, `zmail search` should accept the command without free-text query terms.
- **Workaround today:** Agents add a dummy term like `"title"` or another catch-all token, which costs an extra round-trip and subtly changes search semantics.

---

## Reproduction

```bash
zmail search --from "stiller" --limit 10
```

**Current output:**

```text
error: the following required arguments were not provided:
  <QUERY>
```

**Agent workaround:**

```bash
zmail search --from "stiller" --limit 10 "title"
```

That retry succeeds, but only after the caller learns an implementation detail: the CLI insists on a text query even when the filters alone fully specify the intent.

---

## Root cause

The CLI contract models `search` as "required text query plus optional filters" instead of "query terms and filters are both optional inputs, with at least one search constraint required." That contract is stricter than the actual retrieval capability: the search layer already has meaningful filter-only semantics via `fromAddress`, `toAddress`, `before`, `after`, and related fields.

This creates a mismatch between:

- what agents naturally try first,
- what MCP-style search APIs already allow, and
- what the CLI parser currently accepts.

---

## Skill mitigation assessment

**Published skill mitigation:** **Medium to high.**

A strong published skill can substantially reduce first-try failures by telling agents how to express sender/date-only searches with the current CLI contract and by documenting the current workaround. But the need for that workaround still signals an agent-unfriendly CLI surface, so the long-term fix should be in the interface itself, not only in the skill.

---

## Recommendations

1. **Interface:** Make the positional query optional when at least one narrowing filter is present (`--from`, `--to`, `--subject`, `--before`, `--after`, and similar).
2. **Interface:** Preserve validation by rejecting only the truly unconstrained case: no query text and no filters.
3. **Implementation:** Add regression tests for filter-only CLI searches so this contract remains stable.
4. **Skill/docs:** Update the published skill with explicit current-state guidance for filter-led searches, including the present workaround and a note to prefer dedicated filter parameters over stuffing everything into free text.

---

## References

- Search direction/history: [OPP-003 archived](../opportunities/archive/OPP-003-cli-search-interface.md)
- Related search contract gap: [BUG-020](BUG-020-apple-spending-domain-from-routing.md)
- MCP search docs: [MCP.md](../MCP.md)
