---
name: commit
description: Pre-commit checklist to ensure code quality, test coverage, linting, and documentation accuracy. Use when preparing commits, reviewing changes before commit, or when the user asks about commit requirements or pre-commit checks. When invoked: run the full checklist; if everything is clean, commit and push; only hold off and report if there are issues.
---

# Commit Checklist

Before committing any changes, verify all items in this checklist are satisfied.

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
  - **CLI/MCP sync (if CLI or MCP code changed):** Ensure CLI and MCP stay aligned where they share behavior. If you changed CLI commands, flags, or behavior (e.g. `src/cli/index.ts`, search/who parsing), verify: (1) MCP tools in `src/mcp/index.ts` expose the same options where applicable (e.g. search_mail ↔ search, who ↔ who, get_message/get_thread/list_attachments); (2) `docs/MCP.md` "Available Tools" and "CLI arguments (quick reference)" are updated; (3) `AGENTS.md` attachment/command usage is correct. Run `npm test` — the CLI/MCP sync test will fail if MCP param lists drift from the intended contract.
  - **Verify all links are correct** — especially after moving files to archive
  - **Check for outdated references** — remove references to removed features/flags
  - **Organize bug backlog** — ensure fixed bugs are archived, superseded bugs are noted
  - **Organize opportunities** — ensure implemented opportunities are moved to archive
  - **Follow DRY principle** — single source of truth, cross-reference don't duplicate
  - **If you skip this step, the commit will be incomplete and require a follow-up fix**

### 2. Test Coverage
- [ ] **For any new/changed code, ensure there is test coverage**
  - New functions, classes, or modules have corresponding tests
  - Changed behavior is covered by updated or new tests
  - Edge cases and error paths are tested
  - Use `npm test` to verify tests exist and pass

### 3. Linting
- [ ] **Lint must be clean**
  - Run `npm run lint` (which runs `tsc --noEmit`)
  - Fix all TypeScript errors and warnings
  - No type errors, unused variables, or other linting issues

### 4. Tests
- [ ] **All tests must pass**
  - Run `npm test` and verify all tests pass
  - No failing tests, no skipped tests (unless intentionally)
  - Test output shows all green checkmarks

## Quick Commands

```bash
# Run linting
npm run lint

# Run tests
npm test

# Run both (recommended before commit)
npm run lint && npm test
```

## Documentation DRY Principle

When updating documentation:

1. **Identify the canonical source** — Where does this fact live? (e.g., AGENTS.md for commands, ARCHITECTURE.md for technical decisions)
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
- You're explicitly told to skip (e.g., WIP commits, experimental branches) — but doc review still recommended

For any code changes (even small ones), all checklist items apply, especially documentation review.

## Final Step: Commit and Push

**If everything is clean, commit and push. Do not hold off — complete the commit and push.** Only stop and report to the user when there are issues (lint failures, test failures, or documentation gaps that need human input).

When all checklist items are complete, tests and lint are clean:

1. **VERIFY documentation review is complete** — this is the most common mistake
2. Stage your changes: `git add .`
3. Commit with a descriptive message: `git commit -m "your message"`
4. Push to remote: `git push`

Before committing, confirm:
- ✅ **Documentation review is complete** (MANDATORY - check this first!)
- ✅ All checklist items are satisfied
- ✅ `npm run lint` passes with no errors
- ✅ `npm test` passes with all tests green
- ✅ Documentation is updated, organized, and follows DRY principles
- ✅ Bug backlog is organized (fixed bugs archived, superseded bugs noted)
- ✅ Opportunities are organized (implemented opportunities moved to archive)
- ✅ All links are correct and point to the right locations

Only hold off (do not commit/push) when:
- Lint fails or tests fail — report the failures and what to fix
- Documentation or backlog updates need a decision (e.g., whether to archive an opportunity)
- User has explicitly asked for a dry run or review-only
