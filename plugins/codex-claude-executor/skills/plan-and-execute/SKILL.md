---
name: plan-and-execute
description: Use when the user wants Codex to plan implementation work, delegate execution to local Claude Code, and autonomously review and repair the result.
---

# Plan and Execute

Codex plans and verifies. Claude edits the workspace and runs code-level checks. Codex never takes over implementation without explicit user authorization.

## Responsibility Boundary

- Claude owns all implementation edits plus relevant tests, builds, lint checks, and typechecks.
- Codex owns planning, independent review, final verification, previews, and browser checks.
- In `claude_write_only`, Codex must never take over implementation edits, even when Claude appears slow, has not created files yet, or the delegated execution is interrupted.
- While a `claude_write_only` job for a workspace remains `running`, `restarting`, or `cancelling`, Codex must not edit files in that workspace, even to "finish one side", "补上另一半", or clean up a partial intermediate diff.
- Claude must not run previews or browser verification.
- `Read`, `Glob`, `Grep`, `Edit`, `Write`, unrestricted `Bash`, and common test/build/lint/typecheck commands are fixed permissions. Never ask the user to reconfirm them.
- Claude execution is non-interactive. Claude must never ask the user questions; it should make safe reasonable decisions or return a structured error that identifies the missing essential information.
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
3. Poll `get_execution_status` until the job reaches a terminal state. `running`, `restarting`, and `cancelling` are never final outcomes; do not report success or failure from an intermediate file check. Partial workspace diffs during these states are not permission for Codex to intervene or patch code. Make the first status check after roughly 15 seconds. After that, healthy long-running jobs should usually be checked about once per minute.
4. Non-terminal Claude jobs must never be presented to the user as finished. If the job is still `running`, `restarting`, or `cancelling`, keep monitoring unless the user explicitly stops or changes topic.
5. Relay meaningful changes from `progress.message` to the user while Claude is running. Do not invent percentages. Prefer event-driven updates over routine narration. Short jobs may still emit a sparse heartbeat about every 3 minutes, medium jobs about every 4 minutes, and long healthy jobs may be checked as slowly as every 5 minutes.
6. Use `get_execution_logs` when progress stalls, after a restart, or when a terminal error needs diagnosis. Do not read logs on every loop just because they are available.
7. Claude must run relevant tests, builds, lint checks, and typechecks before returning success.
8. Keep long-running work observable and recoverable: Claude should run the main work in the foreground, emit periodic progress for long commands, and split large work into recoverable checkpoints.
9. The worker automatically restarts Claude after 15 minutes without activity, for at most three total attempts.
10. Never call `cancel_execution` unless the user explicitly asks to cancel. For `claude_write_only`, pass `userRequested: true` only after that explicit request.

### Phase 3: Handle Claude Result

1. If Claude returns `failed` or `environment_error`, stop immediately and report the exact Claude error, relevant logs, and current changed state.
2. Ask the user whether to continue waiting, investigate the cause, retry Claude, or explicitly authorize Codex to take over. Do not choose for the user.
3. A stalled Claude run is retried by the worker. If all attempts stall, the job returns `failed` with exact attempt and log details, then follow the same user-decision gate.
4. If the user explicitly requests cancellation, call `cancel_execution` with `userRequested: true`, then stop and report the cancellation.
5. If Claude returns `completed`, continue to Codex verification. Do not trust Claude's success claim by itself.

### Phase 4: Codex Verification And Repair Loop

1. Independently inspect the actual workspace changes and compare them with the plan and acceptance criteria.
2. Review Claude's reported test, build, lint, and typecheck evidence; rerun critical checks when needed.
3. Perform all required previews and browser checks using Codex's own capabilities.
4. If Codex verification fails, create a focused repair plan and delegate it to Claude. Codex must not directly patch the code.
5. Include exact failure evidence, expected behavior, and required checks in every repair plan.
6. Repeat execution and verification until Codex verification passes.
7. Stop the loop when Claude returns `failed` or `environment_error`, or when the user cancels, and ask the user how to proceed.

### Phase 5: Complete

1. Report success only after Codex verification passes.
2. Report changed files, Claude's code-check results, Codex verification results, and any remaining risks.

## Terminal State Rules

- `completed`: verify; repair automatically if verification fails.
- `failed`: stop, report Claude's exact error, and ask the user how to proceed.
- `environment_error`: stop, report the exact Claude environment problem, and ask the user how to proceed.
- `timed_out`: compatibility-only state; report it as an execution configuration error.
- `cancelled`: stop because the user requested cancellation.
