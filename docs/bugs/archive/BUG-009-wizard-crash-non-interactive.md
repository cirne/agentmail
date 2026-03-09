# BUG-009: `zmail wizard` Crashes with Stack Trace on Non-Interactive Stdin — Agent-Reported

**Status:** Fixed.

**Design lens:** [Agent-first](../VISION.md) — agents invoke commands via subprocess with piped stdio; interactive commands should detect non-TTY mode and fail gracefully with a clear error message, not crash with a stack trace.

**Reported context:** Agent on macOS (Darwin 25.3.0); zmail config: none (fresh install, no `~/.zmail/`). Reproducibility: Always (any non-TTY stdin).

---

## Summary

Agent (or script) invokes `zmail wizard` in a non-TTY environment. The interactive prompt library throws an unhandled `ExitPromptError` and prints a full Node.js stack trace. Agents will typically hit this since they call commands via subprocess with piped stdio.

---

## What the agent did (and what happened)

1. Ran `zmail wizard` with piped or closed stdin (any non-TTY context):
   ```bash
   echo "" | zmail wizard
   ```
2. **Expected:** Graceful error message, e.g.:
   ```
   Wizard requires an interactive terminal. Use 'zmail setup' instead.
   ```
   Exit code 1, no stack trace.
3. **Actual:** Unhandled `ExitPromptError` with full stack trace:
   ```
   file:///Users/cirne/dev/zmail/node_modules/@inquirer/core/dist/lib/create-prompt.js:64
             reject(new ExitPromptError(`User force closed the prompt with ${code} ${signal}`));
                    ^

   ExitPromptError: User force closed the prompt with 0 null
       at file:///Users/cirne/dev/zmail/node_modules/@inquirer/core/dist/lib/create-prompt.js:64:20
       at Emitter.emit (/Users/cirne/dev/zmail/node_modules/signal-exit/src/index.ts:108:13)
       at SignalExit.#processEmit (/Users/cirne/dev/zmail/node_modules/signal-exit/src/index.ts:304:21)
       at process.#process.emit (/Users/cirne/dev/zmail/node_modules/signal-exit/src/index.ts:248:31)
       at process.callbackTrampoline (node:internal/async_hooks:130:17)
   ```

---

## Root causes

1. **Missing TTY guard:** The `wizard` command doesn't check `process.stdin.isTTY` before launching inquirer prompts.
2. **Unhandled exception:** The inquirer library throws `ExitPromptError` when stdin is closed, but this exception isn't caught and handled gracefully.

---

## Recommendations (concise)

1. **Check `process.stdin.isTTY` before launching prompts:** At the start of `wizard`, detect non-TTY stdin and exit with a clear error message:
   ```
   Wizard requires an interactive terminal. Use 'zmail setup' instead.
   ```
2. **Alternative: Wrap inquirer calls in try/catch:** Catch `ExitPromptError` and convert to a user-friendly error message.

---

## Additional Notes

- The `--help` output correctly suggests `zmail wizard` for interactive use and `zmail setup` for CLI/agent use. The issue is just missing a guard at the start of `wizard` to detect non-TTY stdin.

---

## Fix

Fixed by adding TTY check at the start of `runWizard()` function in `src/cli/wizard.ts`:
- Check `process.stdin.isTTY` before launching any interactive prompts
- Exit with code 1 and clear error message if stdin is not a TTY
- Prevents `ExitPromptError` from being thrown

Test case: `src/cli/wizard-non-interactive.test.ts` verifies the fix.

## References

- Vision (agent-first): [VISION.md](../VISION.md)
- Related: [BUG-006](BUG-006-sync-repeated-connecting-message.md), [OPP-009](../opportunities/archive/OPP-009-agent-friendly-setup.md) — Agent-Friendly Setup (implemented wizard)
