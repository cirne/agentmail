# BUG-018: `zmail who --timings` Unknown Flag — Agent-Reported

**Status:** Open.

**Design lens:** [Agent-first](../../VISION.md) — CLI flags should be consistent across commands. When an agent tries a flag that works on `search` but not `who`, it wastes a tool call round (15–25s LLM overhead) discovering the inconsistency.

**Reported context:**
- **Bakeoff #5 (2026-03-07):** CLI agent attempted `zmail who "Marcio Nunes" --timings` expecting the same timing output as `zmail search --timings`. The command failed with an unknown flag error. The agent then re-ran without the flag, wasting one tool call.

---

## Summary

`zmail who` does not accept `--timings`, but `zmail search` does. Agents that have learned to use `--timings` for diagnostics will try it on `who` and get an error, requiring a retry. In a workflow where each round costs 15–25s in LLM thinking time, this is a concrete cost.

---

## Root causes

`zmail search` has explicit support for `--timings` which appends timing metadata to the output. `zmail who` has no equivalent — the flag is either rejected as unknown or silently ignored. Likely the CLI command definition for `who` simply doesn't register the flag.

---

## Recommendations

1. Add `--timings` flag to `zmail who` (and any other commands that lack it) — output timing metadata alongside results in JSON or as a trailing comment in text mode.
2. Alternatively, make `--timings` a global flag accepted by all commands, forwarded to the underlying implementation.
3. At minimum, if a flag is unrecognized, print a clear error message rather than crashing — agents should never have to distinguish "command failed" from "unknown flag error" without reading error output.

---

## References

- Vision (agent-first): [VISION.md](../../VISION.md)
- Bakeoff: `../ztest/feedback/submitted/bakeoff-005-entrepreneur-rematch.md`
- Related: OPP-018 (reduce agent round-trips) — consistent CLI flags reduce wasted calls
