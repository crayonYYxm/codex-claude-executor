# Codex Claude Executor

A Codex plugin that lets Codex plan implementation work, delegate execution to local Claude Code, and autonomously verify and repair the resulting changes.

## What It Does

This plugin enables a workflow where:

1. **Codex inspects** a repository and prepares an implementation plan
2. **Claude receives fixed file CRUD and unrestricted Bash permissions for the delegated run**
3. **Codex starts** a background Claude execution through the bundled MCP server
4. **The MCP server** starts a detached persistent worker that invokes the locally installed Claude Code CLI
5. **The worker** survives MCP/Codex restarts, persists progress and logs, and restarts stalled Claude runs
6. **Codex independently verifies** the result, including preview/browser checks when needed
7. **If verification fails**, Codex sends Claude a focused repair plan and repeats until verification passes

### Collaboration Modes

- `standard`: the default behavior. Codex plans, delegates, reviews, and may choose to patch issues itself outside delegated runs.
- `claude_write_only`: Codex stays in a planner/reviewer role while Claude is expected to perform all code changes inside the delegated run. If review later finds issues, Codex should issue a follow-up plan instead of directly patching code unless the user explicitly overrides that workflow.

For `claude_write_only` jobs, `cancel_execution` rejects cancellation unless
`userRequested: true` is supplied after an explicit user cancellation request.
Repeated `get_execution_status` calls are throttled server-side to prevent tight
polling loops.

If Claude fails or cannot recover from an interruption, Codex must report the
evidence and ask the user whether to wait, investigate, retry Claude, or
explicitly authorize Codex takeover. Codex does not select takeover on its own.
While a `claude_write_only` job is still `running`, `restarting`, or
`cancelling`, Codex must not patch files in that workspace, even if an
intermediate diff shows only part of the planned change has landed.

## Architecture

```
User
  │
  ▼
Codex + plan-and-execute Skill
  │ background implementation or repair plan
  ▼
Bundled stdio MCP Server
  │ detached persistent job
  ▼
Persistent Worker
  │ spawn without shell; retry stalled runs
  ▼
Local claude -p process
  │ edits files and runs allowed commands
  ▼
Structured MCP result or background job status
  │
  ▼
Codex independently verifies actual workspace
  │ verification failure: focused repair plan
  └──────────────────────────────────────────► Claude
```

### Responsibility Boundaries

- **Skill:** Controls the autonomous execute, verify, and repair loop
- **MCP server:** Validates input, controls permissions, recovers persistent jobs, and returns execution evidence
- **Persistent worker:** Owns Claude execution, activity monitoring, retries, logs, and terminal result persistence
- **Claude runner:** Manages only the Claude subprocess lifecycle
- **Workspace module:** Validates paths and captures Git state
- **Permissions module:** Owns all fixed and per-execution tool rules
- **Claude:** Performs implementation plus relevant tests, builds, lint checks, and typechecks
- **Codex:** Performs final review and all preview/browser checks; the MCP server must not claim that work is correct merely because Claude reported success

Claude runs non-interactively. `AskUserQuestion` is disabled at the Claude CLI
boundary, and the execution prompt also instructs Claude not to wait for user
input. When safe, it makes reasonable decisions consistent with the approved
plan. If essential information is missing, it returns a structured error
explaining exactly what is required.

## Prerequisites

- Node.js (v20 or later)
- Claude Code CLI installed and available in `PATH`
- Claude Code authenticated (`claude auth login`)
- Codex CLI installed

## Development

### Install Dependencies

```bash
npm install
```

### Run Tests

```bash
npm test
```

### Type Check

```bash
npm run typecheck:test
```

### Build

```bash
npm run build
```

### Bundle

```bash
npm run bundle
```

### Verify Everything

```bash
npm run verify
```

This runs: `test` → `typecheck:test` → `build` → `bundle`

## Testing

### Run All Tests

```bash
npm test
```

### Run Specific Test File

```bash
npm test -- tests/permissions.test.ts
```

### Run with Coverage

```bash
npm test -- --coverage
```

## MCP Inspector

To test the MCP server interactively:

```bash
# Build first
npm run build

# Run MCP Inspector against the development build
npx @modelcontextprotocol/inspector node build/mcp-server.js
```

## Bundling

The plugin bundles the MCP server into a single file for distribution:

```bash
npm run bundle
```

This creates `dist/mcp-server.mjs` and the detached worker bundle
`dist/job-worker.mjs`.

## Installation

### GitHub Marketplace

Install the marketplace directly from GitHub:

```bash
codex plugin marketplace add crayonYYxm/codex-claude-executor
codex plugin add codex-claude-executor@crayonyyxm
```

Start a new Codex thread after installation.

To update:

```bash
codex plugin marketplace upgrade crayonyyxm
codex plugin add codex-claude-executor@crayonyyxm
```

### Manual MCP Registration (Not Required)

The plugin bundles its MCP server, so you do **not** need to run:
```bash
# This is NOT required - the plugin handles MCP registration automatically
codex mcp add claude-executor ...
```

## Permission Model

### Fixed Allowed Tools

The plugin includes a fixed allowlist of implementation tools:

**File and Search Tools:**
- `Read`, `Glob`, `Grep`, `Edit`, `Write`

**Shell:**
- Unrestricted `Bash`, including normal file CRUD, project scripts, and Git commands

The execution prompt still instructs Claude not to revert, reset, clean,
checkout, commit, push, deploy, modify unrelated files, or access files outside
the working directory. These are behavioral constraints rather than an OS-level
sandbox. Preview and browser verification remain Codex responsibilities because
they require Codex-side tools.

### Extra Permissions

- Extra permissions are requested per-execution only
- They do not persist between calls
- Maximum 20 additional tools per execution
- Each tool rule is validated (no empty values, no control characters, max 300 chars)

## MCP Tools

- `check_environment`: verifies Node, Claude Code availability, and Claude authentication
- `execute_plan`: compatibility tool that waits for up to 90 seconds, then returns a running job
- `start_execution`: preferred tool; starts implementation or repair asynchronously without risking the MCP client request timeout
- `get_execution_status`: polls an async job until it reaches a terminal state and includes the latest readable Claude progress
- `get_execution_logs`: reads the full incremental Claude event stream or `stderr` log slices from an async job
- `cancel_execution`: requests cancellation of a running async job

`execute_plan` and `start_execution` accept an optional `executionMode` field:

- `standard`
- `claude_write_only`

Example:

```json
{
  "workingDirectory": "/absolute/project/path",
  "plan": "Implement the confirmed feature plan.",
  "executionMode": "claude_write_only"
}
```

They also accept `timeoutSeconds` for backward compatibility. Persistent workers
always execute without a hard Claude deadline. A run with no activity for 15
minutes is restarted automatically, with at most three total attempts.

Persistent jobs are stored under `~/.codex/claude-executor/jobs/`. Terminal jobs
are removed after seven days. Each stdout/stderr log keeps at most the latest
20MB.

### Long-Running Execution

- Claude runs without a hard subprocess deadline.
- A detached persistent worker continues after the MCP server or Codex restarts.
- Job state, progress, logs, and results are persisted on disk.
- The worker treats stdout, stderr, tool events, and thinking events as activity.
- After 15 minutes without activity, the worker restarts Claude from the
  approved plan while preserving existing workspace changes, for at most three
  total attempts.
- Long commands should emit periodic progress, and large tasks should use
  recoverable checkpoints. The main work must stay in the foreground instead of
  being left in an untracked background process.

The defaults can be tuned through `CLAUDE_EXECUTOR_STALL_MS`,
`CLAUDE_EXECUTOR_MAX_ATTEMPTS`, and `CLAUDE_EXECUTOR_LOG_LIMIT_BYTES`. No
software process can continue through machine shutdown, disk failure, or loss
of the underlying Claude service.

## Security Limitations

**Important:** This plugin invokes local Claude Code, which can modify local files.

- Claude Code must already be installed and authenticated
- `execute_plan` can modify local files in the working directory
- `start_execution` can keep modifying local files until the job completes or is cancelled
- Unrestricted `Bash` means Claude can technically run commands or access paths outside the working directory; use this plugin only with trusted plans and repositories
- Extra permissions apply only to one invocation
- Existing uncommitted changes are not automatically isolated or reverted
- The plugin does not create Git worktrees or automatic commits

## Troubleshooting

### Claude Executable Missing

**Error:** `Failed to get Claude version` or `Failed to spawn Claude process`

**Solution:**
1. Ensure Claude Code is installed: `which claude`
2. If installed elsewhere, set `CLAUDE_BIN` environment variable
3. Verify Claude is executable: `claude --version`

### Claude Not Authenticated

**Error:** `Claude is not authenticated`

**Solution:**
1. Login to Claude: `claude auth login`
2. Verify auth status: `claude auth status --json`
3. Ensure `ready: true` in `check_environment` response

### MCP Tool Timeout

**Error:** the MCP client stops waiting after roughly 120 seconds

**Solution:**
1. Use `start_execution` for implementation and repair runs.
2. Poll the returned `jobId` with `get_execution_status`.
3. Leave `timeoutSeconds` omitted; persistent workers do not use a hard deadline.

`timeoutSeconds` is retained for compatibility and does not change the MCP
client timeout or persistent worker lifetime.

### Long-Running Tasks

**Problem:** The task may exceed the outer Codex or MCP request timeout even though Claude is still making progress.

**Solution:**
1. Use `start_execution` instead of `execute_plan`
2. Poll with `get_execution_status`
3. Read progress with `get_execution_logs`
4. Cancel with `cancel_execution` if the run is stuck or no longer needed

While a job is running, `get_execution_status` includes:

```json
{
  "status": "running",
  "attempt": 1,
  "maxAttempts": 3,
  "recoveryCount": 0,
  "lastActivityAt": "2026-06-13T10:20:00.000Z",
  "failureKind": null,
  "logsTruncated": { "stdout": false, "stderr": false },
  "progress": {
    "eventCount": 4,
    "message": "Using Write: src/example.ts",
    "updatedAt": "2026-06-13T10:20:00.000Z"
  }
}
```

Progress is stage-based rather than percentage-based because Claude does not
expose a reliable total step count. A worker restarts Claude after 15 minutes
without activity. After the Claude process exits, the job
changes from `running` to one terminal state: `completed`, `failed`,
`timed_out`, `cancelled`, or `environment_error`. A zero process exit code is
still reported as `failed` when Claude's final result has `is_error: true` or
does not contain a final structured `success` result.

Callers must continue polling while the status is `running`, `restarting`, or
`cancelling`. Intermediate file checks are useful for progress visibility but
must not be treated as the final execution result.

### Plugin MCP Not Visible

**Problem:** Codex doesn't see the MCP tools

**Solution:**
1. Verify `dist/mcp-server.mjs` exists: `ls -la dist/`
2. Rebuild if missing: `npm run bundle`
3. Restart Codex after plugin installation
4. Check `.mcp.json` is valid JSON

### Invalid Claude JSON Output

**Error:** `Invalid JSON output from Claude despite zero exit code`

**Solution:**
1. Check Claude version: `claude --version`
2. Try running Claude manually: `claude -p "test" --output-format json`
3. Update Claude Code if needed

## Uninstall or Disable

To uninstall the plugin:

```bash
codex plugin remove codex-claude-executor@crayonyyxm
```

To disable without removing:

```toml
# ~/.codex/config.toml
[plugins."codex-claude-executor@crayonyyxm"]
enabled = false
```

## License

MIT
