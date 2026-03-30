# BUG-028: `zmail inbox --text` Panics on Multi-Byte UTF-8 at Snippet Wrap Boundary — Agent-Reported

**Status:** Fixed (2026-03-30). **Created:** 2026-03-30. **Tags:** inbox, text, utf-8, rust, cli

**Resolution:** `wrap_line` in [`src/refresh.rs`](../../../src/refresh.rs) now uses `str::floor_char_boundary(width)` before slicing the prefix for wrapping, so a byte limit (e.g. 100) never splits a multi-byte character such as the truncation ellipsis `…` (U+2026). Unit tests in `refresh::wrap_line_tests` (ellipsis-at-boundary, space break, short line).

**Design lens:** [Agent-first](../../VISION.md) — `zmail inbox --text` is a human-readable digest primitive; it must not crash on valid Unicode snippets that the tool itself produces.

**Reported context:** macOS Darwin 25.4.0 arm64; Rust `zmail`; ~26k messages; reproduces when a message snippet ends with the truncation ellipsis `…` (U+2026, 3-byte UTF-8). Session 2026-03-30.

---

## Summary (historical)

`zmail inbox <window> --text` panicked while wrapping the snippet for display. A fixed **byte** width (100) was used to slice the string (`rest[..width]`), but **100 is not always a character boundary**. When the snippet ended with `…`, byte index 100 could land inside that character and Rust panicked: `byte index 100 is not a char boundary`.

**Workaround (no longer required):** JSON output without `--text`.

---

## What the agent did (and what happened)

1. Ran `zmail inbox 24h --text`.
2. Process exited 101 after panic; only messages printed before the failing row appear; remainder lost.

**Panic (example):**

```
thread 'main' panicked at src/refresh.rs:246:32:
byte index 100 is not a char boundary; it is inside '…' (bytes 98..101) of `... Chase card…`
```

---

## Root causes

1. **`wrap_line` in `src/refresh.rs`** used `rest[..width]` assuming byte `width` was always a safe slice end — false for multi-byte UTF-8.
2. The ellipsis `…` is added by zmail’s own SQL truncation, so the failure mode was **self-inflicted** for common truncated previews.

---

## References

- Vision (agent-first): [VISION.md](../../VISION.md)
- Related inbox behavior (different issue): [BUG-024](../BUG-024-inbox-scan-over-filters-misses-important-mail.md)
