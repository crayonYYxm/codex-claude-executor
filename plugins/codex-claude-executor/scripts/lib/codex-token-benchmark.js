import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";

export const DEFAULT_PLUGIN_ID =
  "plugin://codex-claude-executor@crayonyyxm";

const EXECUTOR_TOOL_NAMES = new Set([
  "check_environment",
  "execute_plan",
  "start_execution",
  "get_execution_status",
  "get_execution_logs",
  "cancel_execution",
]);

const TOKEN_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

function parseJsonl(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export function extractSessionIdFromJsonl(text) {
  for (const event of parseJsonl(text)) {
    if (event?.type === "session_meta" && typeof event?.payload?.id === "string") {
      return event.payload.id;
    }
  }
  return null;
}

export function extractLatestTokenUsageFromJsonl(text) {
  let latest = null;
  for (const event of parseJsonl(text)) {
    if (
      event?.type === "event_msg" &&
      event?.payload?.type === "token_count" &&
      event?.payload?.info?.total_token_usage
    ) {
      latest = event.payload.info.total_token_usage;
    }
  }

  if (!latest) {
    throw new Error("No token_count event found in Codex JSONL transcript.");
  }

  const usage = {};
  for (const key of TOKEN_KEYS) {
    if (typeof latest[key] !== "number") {
      throw new Error(`Missing numeric token usage field: ${key}`);
    }
    usage[key] = latest[key];
  }
  return usage;
}

export function detectExecutorUsage(text) {
  for (const event of parseJsonl(text)) {
    if (
      event?.type === "response_item" &&
      event?.payload?.type === "function_call" &&
      EXECUTOR_TOOL_NAMES.has(event.payload.name)
    ) {
      return true;
    }
  }
  return false;
}

export function buildVariantPrompt(
  basePrompt,
  variant,
  executionMode = "standard",
  pluginId = DEFAULT_PLUGIN_ID
) {
  const trimmedPrompt = basePrompt.trim();
  if (!trimmedPrompt) {
    throw new Error("Benchmark prompt must not be empty.");
  }

  if (variant === "direct") {
    return [
      "Complete this task directly in Codex.",
      "Do not use the codex-claude-executor plugin or delegate to Claude Code.",
      "",
      trimmedPrompt,
    ].join("\n");
  }

  if (variant === "plugin") {
    const modeInstruction =
      executionMode === "claude_write_only"
        ? 'When you delegate through codex-claude-executor, set executionMode to "claude_write_only".'
        : 'When you delegate through codex-claude-executor, use executionMode "standard".';
    return [
      `Use [@codex-claude-executor](${pluginId}) for this task.`,
      "Delegate the implementation work through the plugin instead of completing it directly in Codex.",
      modeInstruction,
      "",
      trimmedPrompt,
    ].join("\n");
  }

  throw new Error(`Unknown benchmark variant: ${variant}`);
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizeVariant(runs) {
  const summary = {
    runCount: runs.length,
    mean: {},
    min: {},
    max: {},
    mean_duration_ms: mean(runs.map((run) => run.durationMs)),
  };

  for (const key of TOKEN_KEYS) {
    const values = runs.map((run) => run.tokenUsage[key]);
    summary.mean[key] = mean(values);
    summary.min[key] = Math.min(...values);
    summary.max[key] = Math.max(...values);
  }

  return summary;
}

export function summarizeBenchmarks(results) {
  const directRuns = results.filter((result) => result.variant === "direct");
  const pluginRuns = results.filter((result) => result.variant === "plugin");

  if (directRuns.length === 0 || pluginRuns.length === 0) {
    throw new Error("Benchmark summary requires both direct and plugin runs.");
  }

  const direct = summarizeVariant(directRuns);
  const plugin = summarizeVariant(pluginRuns);
  const delta = {};

  for (const key of TOKEN_KEYS) {
    const absolute = plugin.mean[key] - direct.mean[key];
    delta[key] = absolute;
    delta[`${key}_percent`] =
      direct.mean[key] === 0 ? null : (absolute / direct.mean[key]) * 100;
  }

  return { direct, plugin, delta };
}

function formatCodexArgs({
  model,
  workspacePath,
}) {
  const args = [
    "exec",
    "--json",
    "--color",
    "never",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    workspacePath,
  ];
  if (model) {
    args.push("--model", model);
  }
  args.push("-");
  return args;
}

export async function runCodexBenchmarkOnce({
  artifactsRoot,
  basePrompt,
  codexBin = process.env.CODEX_BIN ?? "codex",
  executionMode = "standard",
  model,
  pluginId = DEFAULT_PLUGIN_ID,
  runIndex,
  variant,
  workspaceTemplate,
}) {
  const runRoot = path.join(artifactsRoot, variant, `run-${runIndex}`);
  const workspacePath = path.join(runRoot, "workspace");
  const transcriptPath = path.join(runRoot, "transcript.jsonl");
  const stderrPath = path.join(runRoot, "stderr.log");

  await fs.mkdir(runRoot, { recursive: true });
  await fs.cp(workspaceTemplate, workspacePath, { recursive: true });

  const prompt = buildVariantPrompt(
    basePrompt,
    variant,
    executionMode,
    pluginId
  );
  const args = formatCodexArgs({
    model,
    workspacePath,
  });

  const startedAt = Date.now();
  const child = spawn(codexBin, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(prompt);

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  const durationMs = Date.now() - startedAt;

  await fs.writeFile(transcriptPath, stdout, "utf-8");
  await fs.writeFile(stderrPath, stderr, "utf-8");

  if (exitCode !== 0) {
    throw new Error(
      `Codex exited with code ${exitCode} for ${variant} run ${runIndex}. See ${stderrPath}`
    );
  }

  const executorUsed = detectExecutorUsage(stdout);
  if (variant === "plugin" && !executorUsed) {
    throw new Error(
      `Plugin benchmark run ${runIndex} did not call codex-claude-executor tools. See ${transcriptPath}`
    );
  }
  if (variant === "direct" && executorUsed) {
    throw new Error(
      `Direct benchmark run ${runIndex} unexpectedly used codex-claude-executor. See ${transcriptPath}`
    );
  }

  return {
    variant,
    runIndex,
    sessionId: extractSessionIdFromJsonl(stdout),
    transcriptPath,
    workspacePath,
    tokenUsage: extractLatestTokenUsageFromJsonl(stdout),
    durationMs,
    executorUsed,
  };
}
