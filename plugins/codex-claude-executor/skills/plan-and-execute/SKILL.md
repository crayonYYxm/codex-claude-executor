---
name: plan-and-execute
description: Use when the user wants Codex to plan implementation work, delegate execution to local Claude Code, and autonomously review and repair the result.
---

# Plan and Execute

Codex plans and verifies. Claude edits the workspace and runs code-level checks. The workflow continues autonomously through focused repair runs until Codex verification passes or Claude itself reports an execution error.

## Responsibility Boundary

- Claude owns all implementation edits plus relevant tests, builds, lint checks, and typechecks.
- Codex owns planning, independent review, final verification, previews, and browser checks.
- Claude must not run previews or browser verification.
- `Read`, `Glob`, `Grep`, `Edit`, `Write`, and common test/build/lint/typecheck commands are fixed permissions. Never ask the user to reconfirm them.
- Never automatically revert user or Claude changes.

## Workflow

### Phase 1: Environment And Plan

1. Call `check_environment` before the first delegation in a thread.
2. If it reports not ready, explain the exact Claude environment problem and stop before execution.
3. Inspect the repository using Codex's own read-only capabilities.
4. Produce a concrete implementation plan and acceptance criteria.
5. Identify only non-fixed Claude tool permissions. Obtain confirmation for those permissions when required.
6. Use `claude_write_only` when Codex must remain strictly in the planner/reviewer role.

### Phase 2: Execute And Report Progress

1. Use `start_execution` by default for implementation and repair runs so the MCP client never waits on the long-running Claude request.
2. The detached persistent worker survives MCP and Codex restarts. Leave `timeoutSeconds` omitted; it is retained only for compatibility and the worker always runs without a hard deadline.
3. Poll `get_execution_status` until the job reaches a terminal state.
4. Relay meaningful changes from `progress.message` to the user while Claude is running. Do not invent percentages.
5. Use `get_execution_logs` when progress stalls or a terminal error needs diagnosis.
6. Claude must run relevant tests, builds, lint checks, and typechecks before returning success.
7. The worker automatically restarts Claude after 15 minutes without activity, for at most three total attempts.

### Phase 3: Handle Claude Result

1. If Claude returns `failed` or `environment_error`, stop immediately and report the exact Claude error, relevant logs, and current changed state.
2. A stalled Claude run is retried by the worker. If all attempts stall, the job returns `failed` with exact attempt and log details.
3. If the user cancels the job, stop and report the cancellation.
4. If Claude returns `completed`, continue to Codex verification. Do not trust Claude's success claim by itself.

### Phase 4: Codex Verification And Repair Loop

1. Independently inspect the actual workspace changes and compare them with the plan and acceptance criteria.
2. Review Claude's reported test, build, lint, and typecheck evidence; rerun critical checks when needed.
3. Perform all required previews and browser checks using Codex's own capabilities.
4. If Codex verification fails, create a focused repair plan and delegate it to Claude without asking the user to reconfirm.
5. Include exact failure evidence, expected behavior, and required checks in every repair plan.
6. Repeat execution and verification until Codex verification passes.
7. Stop the loop only when Claude returns `failed` or `environment_error`, or when the user cancels.

### Phase 5: Complete

1. Report success only after Codex verification passes.
2. Report changed files, Claude's code-check results, Codex verification results, and any remaining risks.

## Terminal State Rules

- `completed`: verify; repair automatically if verification fails.
- `failed`: stop and report Claude's exact error.
- `environment_error`: stop and report the exact Claude environment problem.
- `timed_out`: compatibility-only state; report it as an execution configuration error.
- `cancelled`: stop because the user requested cancellation.
