# BUG-036: PDF Attachments Not Surfaced When Filename Has Non-ASCII Characters — Agent-Reported

**Status:** Fixed (verified 2026-04-03). **Created:** 2026-04-03. **Tags:** attachments, pdf, mime, utf-8, sync, agent-first

**Design lens:** [Agent-first](../../VISION.md) — agents must be able to list, read, and search attachment metadata for real mail. When the raw `.eml` contains a valid PDF but the index shows zero attachments, the agent cannot fulfill tasks that depend on that file.

**Reported context:** zmail 0.1.0, Darwin 25.4.0, ~26k messages indexed (2025-03-30 .. 2026-04-03). Reproducible on a specific Superhuman-sent message (see below).

---

## Summary

- **Observed:** `zmail attachment list` returns `[]` and search JSON shows no attachment metadata for an email whose raw `.eml` includes a `multipart/mixed` tail with `application/pdf`, base64 body, and `Content-Disposition: attachment; filename="…pdf"` — when the filename contains a non-ASCII character (e.g. `ó` in “Belóved”).
- **Expected:** The PDF appears in `attachment list`, in search attachment fields, and is readable via `zmail attachment read`, optionally with a sanitized filename if the original cannot be preserved losslessly.
- **Impact:** Data-loss class bug from the user’s perspective: the attachment exists on disk in the EML but is invisible to zmail. Any sender that puts raw UTF-8 in quoted `filename=` strings (common for modern clients) can trigger this, not only PDFs — PDF is the reported case.

---

## What the agent did (and what happened)

1. `zmail search "Biblica Partner Brochure" --json` → found message id `mndggde5.bee11675-3213-4543-9bb4-86ed7af5109d@we.are.superhuman.com`.
2. `zmail attachment list "<id>"` → `[]`.
3. Inspection of the `.eml` shows a valid PDF part with headers:

```text
Content-Disposition: attachment; filename="Belóved in Christ Last Mile First Partnership (March 2026).pdf"
Content-Type: application/pdf; name="Belóved in Christ Last Mile First Partnership (March 2026).pdf"
```

Base64 payload decodes to `%PDF-1.7`.

---

## Root causes

The raw message encodes the filename as **UTF-8 bytes inside the ASCII-only quoted-string** for `filename=` (e.g. `ó` → `0xC3 0xB3`), without RFC 2231 (`filename*=UTF-8''…`) or RFC 2047 encoding.

The MIME parser path used when indexing attachments appears to **reject or drop** the entire part when `Content-Disposition` / `Content-Type` parameters contain non-ASCII bytes in the quoted string, instead of decoding UTF-8 or falling back to a generic name (e.g. `attachment-1.pdf`). That yields **no rows** in the attachment index — not merely a wrong filename.

**Related but distinct:** [BUG-023 archived](BUG-023-attachments-missing-from-synced-email.md) fixed dropping attachments when `related: true` coexisted with `disposition: "attachment"`. This report is about **parameter encoding / parser tolerance**, not the related-bit filter.

---

## Resolution

Fixed in Rust (2026-04-03): `parse_raw_message` / `collect_attachments` (`src/sync/parse_message.rs`) surfaces attachment parts with UTF-8-tolerant disposition/name handling and MIME-type + index fallback filenames; attachment read path updates in `src/attachments/mod.rs`; regression coverage in `tests/attachments_extract.rs` and `tests/sync_parse_maildir.rs`. Node reference parity in `node/src/sync/parse-message.ts` / tests. Dev helper: `cargo run --example parse_eml -- <path.eml>`.

---

## Recommendations (historical — implemented)

1. When parsing `Content-Disposition` / `Content-Type` `filename` / `name` parameters, accept **raw UTF-8 in quoted strings** where the bytes are valid UTF-8 (and document interaction with maildir/EML storage).
2. If decoding fails, **still retain the part**: assign a fallback filename from MIME type and part index (e.g. `attachment-1.pdf`) rather than dropping the attachment.
3. Ensure **RFC 2231** (`filename*=`) and **RFC 2047** encoded filenames remain handled; add regression tests for UTF-8-in-quoted-string and for mixed encodings.

---

## References

- Vision (agent-first): [VISION.md](../../VISION.md)
- Prior attachment indexing: [BUG-023 archive](BUG-023-attachments-missing-from-synced-email.md)
- Feedback source: `../../../ztest/feedback/bug-attachment-not-detected-non-ascii-filename.md`
