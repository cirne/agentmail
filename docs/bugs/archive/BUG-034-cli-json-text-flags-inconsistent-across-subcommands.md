# BUG-034: CLI Rejects `--json` on `search` and `--text` on `thread` — Agent-Reported

**Status:** Fixed (2026-04-01). **Created:** 2026-04-01. **Tags:** cli, ux, agent-first

**Design lens:** [Agent-first](../../VISION.md) — LLMs form CLI expectations from broad training data. Hard errors on flags that are ubiquitous elsewhere (`--json`) or that work on sibling commands (`--text` after `inbox --text`) force retry loops (~500–2000 tokens per failure) and high first-attempt error rates.

**Fix (2026-04-01):** `search` accepts `--json` (no-op; conflicts with `--text`). `thread` accepts `--text` (default output; conflicts with `--json`). Integration tests in `tests/search_fts.rs`.

---

## Summary

During a single session, an agent hit **three** distinct CLI parse errors:

1. **`zmail search "…" --json`** → `unexpected argument '--json'`. Search already defaults to JSON; agents still pass `--json` because it is the de facto structured-output flag (`gh`, `kubectl`, `aws`, etc.).
2. **`zmail thread "<id>" --text`** → `unexpected argument '--text'`. The agent had just used `zmail inbox … --text` and assumed a shared output-format vocabulary across subcommands.
3. **Repeat of (1)** on a later search — in-session correction is fragile; the training prior on `--json` dominates.

**Expected:** Accept `--json` as a no-op where JSON is already the default (at minimum on `search`), and align `thread` with other commands by supporting `--text` (real text mode or no-op with a one-line hint). Broader expectation: consistent `--json` / `--text` (and where applicable `--limit`, `--since`) across agent-facing subcommands, including no-ops where only one format exists.

---

## Reproduction (pre-fix)

```bash
zmail search "from:joshua conference" --json
```

```bash
zmail thread "<thread-or-message-id>" --text
```

**Previous behavior:** clap rejected the flags; suggested `-- --json` / `-- --text`, which is not what agents intend.

---

## Root cause

- **`search`:** JSON is default; there was no `--json` flag, so explicit requests failed.
- **`thread`:** Only one output style; `--text` was not defined, unlike `inbox` / `read` which support `--text`.

Inconsistency across subcommands violated the “consistent flag vocabulary” agents expect.

---

## Recommendations (addressed)

1. Add **`--json` as a no-op** on `search` — **done** (documented in `--help`).
2. On **`thread`:** add **`--text`** — **done** (same as default text table; conflicts with `--json`).
3. Optionally document in help/long-help — **done** via clap help strings and `AGENTS.md` / `root_help.txt`.
4. **Regression:** CLI tests — **done** (`search_cli_accepts_json_flag`, `thread_cli_accepts_text_flag`).

---

## References

- Vision: [VISION.md](../../VISION.md)
- Related: [BUG-032](../BUG-032-search-query-should-be-optional-with-filters.md) (search CLI contract / agent retries)
- Feedback: `../../../ztest/feedback/submitted/ux-cli-agent-friction-and-read-missing-recipients.md` (Part 1)
