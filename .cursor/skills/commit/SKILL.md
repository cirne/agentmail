---
name: commit
description: Pre-commit checklist for the Rust-first codebase (format, clippy, tests, docs). Use when preparing commits, reviewing changes before commit, or when the user asks about commit requirements or pre-commit checks. When invoked: run the full checklist from the repository root; if everything is clean, commit and push. Only hold off when there are failures that you are unable to fix — then report them to the user. Also used by the /commit slash command (.cursor/commands/commit.md).
---

# Commit Checklist

**Primary implementation is Rust** at the repository root (`cargo build`, `cargo test`). The **`node/`** tree is a **read-only reference** artifact (published npm package parity, historical behavior); **do not** treat Node scripts as the default pre-commit path. Before committing any changes, verify all items in this checklist are satisfied. Run commands from the **repository root** unless noted.

## Pre-Commit Checklist

**CRITICAL: Documentation review is MANDATORY and must be completed BEFORE committing. Never skip this step.**

### 1. Documentation Review (MANDATORY - DO THIS FIRST)
- [ ] **MANDATORY: Complete documentation review before any commit**
  - Review all changed files and identify documentation that needs updating
  - Check `docs/BUGS.md` — update bug status if bugs were fixed/superseded
  - Check `docs/OPPORTUNITIES.md` — move opportunities to archive if implemented
  - Check `docs/feedback-processed.md` — update if processing feedback
  - Review `AGENTS.md` — update if CLI/interface changed
  - Review `docs/ARCHITECTURE.md` — update if technical decisions changed
  - Review `docs/MCP.md` — update if MCP interface changed
  - **CLI/MCP sync (if CLI or MCP code changed):** Ensure CLI and MCP stay aligned where they share behavior. If you changed commands, flags, or behavior, verify in **Rust**: `src/main.rs` (CLI), `src/mcp/mod.rs` (MCP tools), and shared modules under `src/`. Check: (1) MCP tools expose the same options where applicable (e.g. search_mail ↔ search, who ↔ who, get_message/get_thread/list_attachments); (2) `docs/MCP.md` "Available Tools" and CLI quick reference are updated; (3) `AGENTS.md` attachment/command usage is correct. Run `cargo test` — integration tests such as `tests/mcp_stdio.rs` (e.g. `mcp_tool_param_keys_stable`) help catch parameter drift.
  - **Verify all links are correct** — especially after moving files to archive
  - **Check for outdated references** — remove references to removed features/flags
  - **Organize bug backlog** — ensure fixed bugs are archived, superseded bugs are noted
  - **Organize opportunities** — ensure implemented opportunities are moved to archive
  - **Follow DRY principle** — single source of truth, cross-reference don't duplicate
  - **If you skip this step, the commit will be incomplete and require a follow-up fix**

### 2. Test Coverage
- [ ] **For any new/changed code, ensure there is test coverage**
  - New functions, modules, or public APIs have corresponding tests (unit tests in `src/**` or integration tests in `tests/`)
  - Changed behavior is covered by updated or new tests
  - Edge cases and error paths are tested
  - Use `cargo test` from the repository root to verify tests exist and pass
  - **MANDATORY: All code changes must have test coverage in the Rust test suite**

### 2a. LLM / OpenAI Code Changes (if applicable)
- [ ] **If changes were made to code that calls OpenAI or LLM-backed flows, verify coverage and behavior**
  - **Detect LLM-related changes:** e.g. `src/ask/`, `src/inbox/` (scan), `async_openai`, OpenAI config, wizard/setup paths that validate API keys
  - **Rust tests must pass:** `cargo test` — extend or add unit tests in `src/**` and integration tests in `tests/` when behavior changes
  - **Manual verification when needed:** For `zmail ask` / inbox scan flows, a full automated eval suite may require `ZMAIL_OPENAI_API_KEY`; run targeted tests and manual smoke checks as appropriate
  - **Reference only:** The npm package under `node/` may still contain `npm run eval` / Vitest eval tests for historical parity; that is **not** the default gate for commits here. Use it only if you are explicitly comparing or verifying parity with the reference implementation

### 3. Formatting and static analysis (Rust)
- [ ] **Rust style and Clippy must be clean** (matches CI: `.github/workflows/ci.yml`)
  - `cargo fmt --all -- --check` — no formatting drift
  - `cargo clippy --all-targets -- -D warnings` — fix all Clippy warnings (CI treats warnings as errors)
  - Prefer idiomatic Rust: avoid unnecessary clones, use `?` and proper error types, keep modules small and testable

### 4. Tests
- [ ] **All tests must pass**
  - Run `cargo test` from the repository root and verify all tests pass
  - No failing tests, no skipped tests (unless intentionally)
  - **Optional smoke:** `cargo build --release` if you changed build-sensitive code (CI runs a release build smoke step)

## Quick Commands

From the **repository root**:

```bash
# Format (apply)
cargo fmt --all

# Format check + Clippy (same expectations as CI)
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings

# Full test suite
cargo test

# Release smoke (optional)
cargo build --release
```

## Documentation DRY Principle

When updating documentation:

1. **Identify the canonical source** — Where does this fact live? (e.g. AGENTS.md for commands, ARCHITECTURE.md for technical decisions)
2. **Update the canonical source** — Make changes there first
3. **Reference, don't duplicate** — Other docs should link to or reference the canonical source
4. **Remove duplicates** — If you find duplicated information, consolidate it into the canonical source and update references

Example:
- ✅ Good: "See [AGENTS.md](AGENTS.md) for installation instructions"
- ❌ Bad: Copying installation instructions into multiple files

## When to Skip Items

**Documentation Review is NEVER skippable** — even for cosmetic changes, you must verify docs are still accurate.

Only skip other checklist items if:
- The change is **purely cosmetic** (whitespace, formatting with no logic changes) — but still do doc review
- The change is **documentation-only** — doc review is the primary task here
- You're explicitly told to skip (e.g. WIP commits, experimental branches) — but doc review still recommended

For any code changes (even small ones), all checklist items apply, especially documentation review.

## Final Step: Commit and Push

**If everything is clean, commit and push. Do not hold off — complete the commit and push.** Only hold off when there are failures that you are unable to fix (e.g. fmt/clippy/test failures you cannot resolve, or documentation/backlog decisions that need human input); then report them to the user.

When all checklist items are complete, tests and static analysis are clean:

1. **VERIFY documentation review is complete** — this is the most common mistake
2. Stage your changes: `git add .`
3. Commit with a descriptive message: `git commit -m "your message"`
4. Push to remote: `git push`

Before committing, confirm:
- ✅ **Documentation review is complete** (MANDATORY - check this first!)
- ✅ All checklist items are satisfied
- ✅ `cargo fmt --all -- --check` passes
- ✅ `cargo clippy --all-targets -- -D warnings` passes
- ✅ `cargo test` passes with all tests green
- ✅ **Test coverage exists** for all code changes in the Rust test suite
- ✅ **If LLM-related code changed:** tests and/or documented manual verification are appropriate
- ✅ Documentation is updated, organized, and follows DRY principles
- ✅ Bug backlog is organized (fixed bugs archived, superseded bugs noted)
- ✅ Opportunities are organized (implemented opportunities moved to archive)
- ✅ All links are correct and point to the right locations

Only hold off (do not commit/push) when there are failures you cannot fix:
- Format, Clippy, or test failures you are unable to resolve — report the failures and what’s wrong
- Documentation or backlog updates that need a human decision (e.g. whether to archive an opportunity)
- User has explicitly asked for a dry run or review-only
