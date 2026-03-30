# BUG-027: Rust `zmail draft` — Opaque “not found” errors and stdin block in non-interactive runs

**Status:** Fixed (2026-03-30). **Created:** 2026-03-30. **Tags:** draft, cli, rust, agent-first, parity

**Resolution:**

- **A (missing draft id):** `read_draft_in_data_dir` maps `ErrorKind::NotFound` to `format_draft_not_found_message` (Node parity with `formatSendDraftNotFoundMessage`). `send_draft_by_id` uses `read_draft_in_data_dir` for the same message. Unit test in `src/send/draft_store.rs`; integration test in `tests/send_drafts.rs`.
- **B (`draft new` + non-TTY stdin):** Already fixed before close: placeholder draft when only `--to`; no stdin read for LLM instruction unless `--instruction` is set.

**Scope:** **Rust CLI** (`cargo run -- draft …`, release `zmail draft`). Node [`runDraftCli`](../../../node/src/cli/send-draft.ts) is the parity reference for messaging and control flow.

**Design lens:** [Agent-first](../../VISION.md) — agents and CI often run subprocesses **without a TTY** on stdin. Commands must **fail fast** with a clear, copy-pastable message (or exit code contract), not **block** waiting for stdin. Missing resources should say **what** is missing and **how to fix** (e.g. `zmail draft list`), not raw OS errors.

---

## Summary (historical)

| Issue | Observed | Expected |
|--------|-----------|----------|
| **A. Missing draft id** | `zmail draft view <bad-id>` failed with e.g. **`No such file or directory (os error 2)`** (propagated from `read` / path open). | User-facing text like Node’s: *Draft not found: \<id\>. Expected file: \<path\>. Run `zmail draft list` to see saved draft ids.* (or equivalent). |
| **B. Incomplete `draft new` + non-TTY stdin** | (Was) `zmail draft new --to …` could **block** on stdin for an instruction in non-TTY environments. | **Fixed:** `draft new` no longer reads stdin for LLM instructions (LLM compose only when `--instruction` is set). When only `--to` is given (no subject/instruction/body), the draft is created with placeholder subject/body (`DRAFT_NEW_PLACEHOLDER_*` in [`src/draft.rs`](../../../src/draft.rs)); `draft edit` / `draft rewrite` can fill in later. |

---

## Reproduction (historical)

**Environment:** Minimal `ZMAIL_HOME` with valid `config.json` (`imap.user`) and `ZMAIL_IMAP_PASSWORD` in `.env` so `draft` passes the IMAP gate (see [`src/main.rs`](../../../src/main.rs) `Commands::Draft`).

**A — view missing id:**

```bash
ZMAIL_HOME=/path/to/minimal zmail draft view does-not-exist-12345
```

**B — new blocks (non-TTY):**

```bash
# In an environment where stdin is not a TTY and remains open without data:
ZMAIL_HOME=/path/to/minimal zmail draft new --to x@y.com
```

---

## Root cause (implementation)

- **A:** [`read_draft_in_data_dir`](../../../src/send/draft_store.rs) / [`read_draft`](../../../src/send/draft_store.rs) surfaced `std::io::Error` without mapping “file missing” to a draft-specific message. [`draft.rs`](../../../src/draft.rs) used `.map_err(|e| e.to_string())?`.
- **B (addressed):** `DraftCmd::New` no longer reads stdin for LLM instructions; placeholder subject/body when only `--to`. Stdin is still used for **manual** compose when `--subject` is set and neither `--body` nor `--body-file` is provided (pipe body).

---

## Related

- Rust draft implementation: [`src/draft.rs`](../../../src/draft.rs), [`src/send/draft_store.rs`](../../../src/send/draft_store.rs).
- Parity tracker: [RUST_PORT.md](../../RUST_PORT.md) (`zmail draft`).
