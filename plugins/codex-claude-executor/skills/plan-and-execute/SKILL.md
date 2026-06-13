---
name: plan-and-execute
description: Use when the user wants Codex to plan implementation work, obtain confirmation, delegate the confirmed plan to local Claude Code, and review the resulting changes.
---

# Plan and Execute

This skill defines the workflow for planning implementation work, obtaining user confirmation, delegating execution to local Claude Code, and reviewing the results.

## Workflow

### Phase 1: Environment

1. Call `check_environment` before the first delegation in a thread.
2. If it reports not ready, explain the exact issue and stop before execution.

### Phase 2: Plan

1. Inspect the repository using Codex's own read-only capabilities.
2. Produce a concrete implementation plan.
3. Identify any Claude tool rules required beyond the fixed allowlist.
4. Decide whether the task is short enough for synchronous execution or should run in the background.
5. Do not call `execute_plan` or `start_execution` yet.

### Phase 3: Confirmation

1. Show the implementation plan to the user.
2. Show every requested extra tool rule and explain why it is needed.
3. Obtain explicit user confirmation.
4. Pass only confirmed extra tool rules.

### Phase 4: Execute

1. For short tasks, call `execute_plan` exactly once for the confirmed plan.
2. For long tasks, call `start_execution` once, then monitor with `get_execution_status` and `get_execution_logs`.
3. Use `cancel_execution` when the user wants to stop a running delegation.
4. Do not silently retry failures.
5. Explain timeouts, execution failures, or environment errors.

### Phase 5: Review

1. Independently inspect the actual workspace changes.
2. Rerun relevant tests using Codex's own tools where permitted.
3. Do not trust Claude's success claim without verification.
4. Report changed files, verified test results, unresolved issues, and any difference from the approved plan.
5. Never automatically revert user or Claude changes.

## Examples

### Example 1: Change with Fixed Permissions Only

**User:** Add a new utility function to `src/utils.ts`.

**Workflow:**
1. Check environment - ready.
2. Plan: Add `formatDate` function to `src/utils.ts` with unit tests.
3. Show plan to user - confirmed.
4. Execute with fixed tools only.
5. Review: Verify `src/utils.ts` was modified, run tests.

### Example 2: Change Requiring Extra Permission

**User:** Add a new CLI command that requires running `npm run generate-types`.

**Workflow:**
1. Check environment - ready.
2. Plan: Add CLI command and type generation.
3. Show plan with extra tool: `Bash(npm run generate-types)` - user confirms.
4. Execute with extra tool.
5. Review: Verify changes and type generation.

### Example 3: Execution Failure

**User:** Refactor the authentication module.

**Workflow:**
1. Check environment - ready.
2. Plan: Refactor auth module with test updates.
3. Show plan to user - confirmed.
4. Execute - Claude reports failure (test failures).
5. Review: Report the failure, show which tests failed, do not retry automatically.
