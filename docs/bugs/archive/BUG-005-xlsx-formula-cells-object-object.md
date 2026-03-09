# BUG-005: XLSX Formula Cells Render as `[object Object]` — Agent-Reported

**Status:** Fixed, verified (2026-03-07).

**Design lens:** [Agent-first](../VISION.md) — agents lose critical numeric data from spreadsheets; for financial/accounting workflows, this data loss is significant.

**Reported context:** Agent on macOS (Darwin 25.2.0); reading an Excel (.xlsx) attachment with formula-based cells (USD currency conversions). Reproducibility: Always with affected attachments; likely affects any XLSX with formulas.

---

## Summary

When reading an XLSX attachment, cells that contain formulas (e.g. currency conversions) render as `[object Object]` instead of their computed/displayed values. The USD column and totals are completely lost in the extracted CSV output.

---

## What the agent did (and what happened)

1. Read an email with an XLSX attachment.
2. Ran `zmail attachment read "<message-id>" "filename.xlsx"`.
3. **Expected:** All cell values render as computed values (numbers, strings, dates).
4. **Actual:** Multiple cells render as `[object Object]`:
   ```
   MARIBEL MERCADO,2 MASSAGES...,4760,[object Object]
   JONATHAN MAURICIO,5 DAYS...,12250,[object Object]
   ,Total (MXN) $Pesos,[object Object],25
   ,Total: $US,,[object Object]
   ```
   No error — exit code 0, but data is corrupted in output.

---

## Root cause (likely)

The XLSX extractor (`src/attachments/index.ts`, `XlsxExtractor`) uses `row.values` from ExcelJS. For formula cells, the value may be an object (e.g. `{ formula, result }` or a RichText/Cell object) rather than a primitive. The code does `String(v)` on each cell value; when `v` is an object, `String(v)` yields `[object Object]`.

**Fix direction:** When iterating cells, extract the display value before stringifying:
- For ExcelJS: use `cell.value` (computed result) or the formatted string equivalent.
- General pattern: `value = (typeof v === 'object' && v !== null && ('value' in v || 'result' in v || 'w' in v)) ? (v.value ?? v.result ?? v.w ?? '') : String(v)`.

---

## Agent-friendliness impact

High — the agent loses critical numeric data. In the reported case, all USD conversion amounts were missing, requiring manual calculation from the exchange rate.

---

## Fix

Fixed in `src/attachments/index.ts` by handling formula cell objects properly:
- Check if cell value is an object (excluding Date)
- Extract computed result from `result`, `value`, or `w` properties
- Fallback to `cell.text` if object structure is unexpected
- Preserves original behavior for primitive values and dates

**Commit:** Fixed XLSX formula cell extraction to handle object values (2026-03-07). Verified with `--no-cache`; all formula/currency cells now render correctly.

## References

- Vision (agent-first): [VISION.md](../VISION.md)
- XLSX extractor: `src/attachments/index.ts` (ExcelJS)
- Related: [BUG-001](archive/BUG-001-attachment-and-read-agent-friction.md), [BUG-002](archive/BUG-002-attachment-discoverability-and-read.md)
