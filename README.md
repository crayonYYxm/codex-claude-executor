# Codex Claude Executor Marketplace

This repository distributes the `codex-claude-executor` Codex plugin.

The plugin lets Codex prepare and confirm an implementation plan, delegate the
confirmed plan to local Claude Code through a bundled MCP server, and then
review the resulting changes.

## Install From GitHub

Prerequisites:

- Codex CLI with plugin marketplace support
- Node.js 20 or later
- Claude Code installed and authenticated

Add this GitHub repository as a marketplace:

```bash
codex plugin marketplace add crayonYYxm/codex-claude-executor
```

Install the plugin:

```bash
codex plugin add codex-claude-executor@crayonyyxm
```

Start a new Codex thread, then invoke `@codex-claude-executor` or ask Codex to
plan a task and delegate the confirmed plan to Claude Code.

## Update

```bash
codex plugin marketplace upgrade crayonyyxm
codex plugin add codex-claude-executor@crayonyyxm
```

Start a new Codex thread after updating.

## Remove

```bash
codex plugin remove codex-claude-executor@crayonyyxm
```

## Repository Structure

```text
.agents/plugins/marketplace.json
plugins/codex-claude-executor/
```

The marketplace catalog lives at the repository root. The installable plugin,
including its bundled MCP server, lives under `plugins/codex-claude-executor/`.

## Development

```bash
cd plugins/codex-claude-executor
npm ci
npm run verify
```

See the [plugin README](plugins/codex-claude-executor/README.md) for architecture,
permissions, security limitations, and troubleshooting.
