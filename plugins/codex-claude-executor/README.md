# Codex Claude Executor

A Codex plugin that lets Codex plan implementation work, obtain user confirmation, delegate execution to local Claude Code, and review the resulting changes.

## What It Does

This plugin enables a workflow where:

1. **Codex inspects** a repository and prepares an implementation plan
2. **Codex shows** the plan and any additional requested permissions to the user
3. **After user confirmation**, Codex calls an MCP tool bundled inside the plugin
4. **The MCP server** invokes the locally installed Claude Code CLI to execute the plan
5. **The MCP server** returns structured execution and workspace information
6. **Codex independently inspects** the resulting changes and reruns relevant tests

## Architecture

```
User
  │
  ▼
Codex + plan-and-execute Skill
  │ confirmed MCP tool call
  ▼
Bundled stdio MCP Server
  │ spawn without shell
  ▼
Local claude -p process
  │ edits files and runs allowed commands
  ▼
Structured MCP result
  │
  ▼
Codex reviews actual diff and reruns tests
```

### Responsibility Boundaries

- **Skill:** Controls the expected Codex workflow and user confirmation
- **MCP server:** Validates input, controls permissions, invokes Claude, and returns execution evidence
- **Claude runner:** Manages only the Claude subprocess lifecycle
- **Workspace module:** Validates paths and captures Git state
- **Permissions module:** Owns all fixed and per-execution tool rules
- **Codex:** Performs final review; the MCP server must not claim that work is correct merely because Claude reported success

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

This creates `dist/mcp-server.mjs` which is the executable entry point for the plugin.

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

The plugin includes a fixed allowlist of safe tools:

**File and Search Tools:**
- `Read`, `Glob`, `Grep`, `Edit`, `Write`

**Safe Git Inspection:**
- `Bash(git status)`, `Bash(git diff)`, `Bash(git log)`, etc.

**Common Build/Test Commands:**
- `Bash(npm test)`, `Bash(npm run build)`, `Bash(pytest)`, etc.

### Extra Permissions

- Extra permissions are requested per-execution only
- They do not persist between calls
- Maximum 20 additional tools per execution
- Each tool rule is validated (no empty values, no control characters, max 300 chars)

## Security Limitations

**Important:** This plugin invokes local Claude Code, which can modify local files.

- Claude Code must already be installed and authenticated
- `execute_plan` can modify local files in the working directory
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

**Error:** `Execution timed out after X seconds`

**Solution:**
1. Increase `timeoutSeconds` in `execute_plan` call (max 7200)
2. Check if Claude is hanging on a prompt
3. Verify Claude can access the working directory

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
