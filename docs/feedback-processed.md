# Processed Feedback

This file tracks feedback files from `../ztest/feedback/` that have been processed. A feedback item is considered "processed" when we have decided what to do with it and completed that action (ignore, create bug, create opportunity, update docs, etc.).

**Format:** Each entry includes:
- Feedback filename
- Date processed
- Action taken (bug created, opportunity created, ignored, etc.)
- Related bug/opportunity ID (if applicable)

---

## Processed Items

| Feedback File | Date Processed | Action | Related ID |
|---|---|---|---|
| `ux-semantic-search-guidance.md` | 2026-03-06 | Created bug | [BUG-003](bugs/archive/BUG-003-fts-vs-semantic-search-guidance.md) — Superseded by OPP-008 |
| `ux-simplify-search-modes.md` | 2026-03-06 | Created opportunity | [OPP-008](opportunities/archive/OPP-008-simplify-search-modes.md) — Implemented 2026-03-06 |

---

## Notes

- This file serves as the source of truth for which feedback has been processed
- Always check this file first before processing feedback to avoid duplicates
- After processing feedback, add an entry here and optionally delete/move the feedback file
- Feedback files can be safely deleted after processing if they're tracked here
