#!/usr/bin/env node

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runCodexBenchmarkOnce,
  summarizeBenchmarks,
} from "./lib/codex-token-benchmark.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_WORKSPACE_TEMPLATE = path.join(
  PROJECT_ROOT,
  "benchmarks",
  "fixtures",
  "greetings-workspace"
);
const DEFAULT_PROMPT_FILE = path.join(
  PROJECT_ROOT,
  "benchmarks",
  "tasks",
  "add-format-greeting.prompt.md"
);

function parseArgs(argv) {
  const options = {
    artifactsDir: path.join(
      PROJECT_ROOT,
      "benchmarks",
      "results",
      new Date().toISOString().replace(/[:.]/g, "-")
    ),
    codexBin: process.env.CODEX_BIN ?? "codex",
    executionMode: "standard",
    model: null,
    output: "table",
    promptFile: DEFAULT_PROMPT_FILE,
    runs: 1,
    workspaceTemplate: DEFAULT_WORKSPACE_TEMPLATE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--artifacts-dir":
        options.artifactsDir = path.resolve(next);
        index += 1;
        break;
      case "--codex-bin":
        options.codexBin = next;
        index += 1;
        break;
      case "--execution-mode":
        options.executionMode = next;
        index += 1;
        break;
      case "--model":
        options.model = next;
        index += 1;
        break;
      case "--output":
        options.output = next;
        index += 1;
        break;
      case "--prompt-file":
        options.promptFile = path.resolve(next);
        index += 1;
        break;
      case "--runs":
        options.runs = Number(next);
        index += 1;
        break;
      case "--workspace-template":
        options.workspaceTemplate = path.resolve(next);
        index += 1;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.runs) || options.runs <= 0) {
    throw new Error("--runs must be a positive integer.");
  }
  if (!["table", "json"].includes(options.output)) {
    throw new Error('--output must be either "table" or "json".');
  }
  if (!["standard", "claude_write_only"].includes(options.executionMode)) {
    throw new Error(
      '--execution-mode must be "standard" or "claude_write_only".'
    );
  }

  return options;
}

function printHelp() {
  console.log(`Compare Codex token usage with and without codex-claude-executor.

Usage:
  node scripts/compare-codex-token-usage.mjs [options]

Options:
  --workspace-template <dir>  Source workspace copied for each run
  --prompt-file <file>        Task prompt to run in both variants
  --runs <n>                  Number of direct/plugin pairs to execute
  --model <name>              Optional Codex model override
  --execution-mode <mode>     standard | claude_write_only
  --artifacts-dir <dir>       Where transcripts, workspaces, and summary are saved
  --codex-bin <path>          Codex CLI binary to execute
  --output <table|json>       Print table or JSON summary
  -h, --help                  Show this help text
`);
}

function percent(value) {
  if (value === null || Number.isNaN(value)) return "n/a";
  return `${value.toFixed(2)}%`;
}

function formatNumber(value) {
  return Number.isInteger(value) ? `${value}` : value.toFixed(2);
}

function printTable(summary, results, artifactsDir) {
  const rows = [
    [
      "Metric",
      "Direct Mean",
      "Plugin Mean",
      "Delta",
      "Delta %",
    ],
    [
      "total_tokens",
      formatNumber(summary.direct.mean.total_tokens),
      formatNumber(summary.plugin.mean.total_tokens),
      formatNumber(summary.delta.total_tokens),
      percent(summary.delta.total_tokens_percent),
    ],
    [
      "input_tokens",
      formatNumber(summary.direct.mean.input_tokens),
      formatNumber(summary.plugin.mean.input_tokens),
      formatNumber(summary.delta.input_tokens),
      percent(summary.delta.input_tokens_percent),
    ],
    [
      "cached_input_tokens",
      formatNumber(summary.direct.mean.cached_input_tokens),
      formatNumber(summary.plugin.mean.cached_input_tokens),
      formatNumber(summary.delta.cached_input_tokens),
      percent(summary.delta.cached_input_tokens_percent),
    ],
    [
      "output_tokens",
      formatNumber(summary.direct.mean.output_tokens),
      formatNumber(summary.plugin.mean.output_tokens),
      formatNumber(summary.delta.output_tokens),
      percent(summary.delta.output_tokens_percent),
    ],
    [
      "reasoning_output_tokens",
      formatNumber(summary.direct.mean.reasoning_output_tokens),
      formatNumber(summary.plugin.mean.reasoning_output_tokens),
      formatNumber(summary.delta.reasoning_output_tokens),
      percent(summary.delta.reasoning_output_tokens_percent),
    ],
  ];

  const widths = rows[0].map((_, columnIndex) =>
    Math.max(...rows.map((row) => row[columnIndex].length))
  );
  const formatted = rows.map((row, index) => {
    const line = row
      .map((cell, columnIndex) => cell.padEnd(widths[columnIndex], " "))
      .join(" | ");
    if (index === 0) {
      const divider = widths.map((width) => "-".repeat(width)).join("-|-");
      return `${line}\n${divider}`;
    }
    return line;
  });

  console.log(formatted.join("\n"));
  console.log("");
  console.log(`Artifacts: ${artifactsDir}`);
  console.log(
    `Runs: ${results.length} (${summary.direct.runCount} direct + ${summary.plugin.runCount} plugin)`
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const basePrompt = await fs.readFile(options.promptFile, "utf-8");
  await fs.mkdir(options.artifactsDir, { recursive: true });

  const results = [];
  for (let runIndex = 1; runIndex <= options.runs; runIndex += 1) {
    results.push(
      await runCodexBenchmarkOnce({
        artifactsRoot: options.artifactsDir,
        basePrompt,
        codexBin: options.codexBin,
        executionMode: options.executionMode,
        model: options.model,
        runIndex,
        variant: "direct",
        workspaceTemplate: options.workspaceTemplate,
      })
    );
    results.push(
      await runCodexBenchmarkOnce({
        artifactsRoot: options.artifactsDir,
        basePrompt,
        codexBin: options.codexBin,
        executionMode: options.executionMode,
        model: options.model,
        runIndex,
        variant: "plugin",
        workspaceTemplate: options.workspaceTemplate,
      })
    );
  }

  const summary = summarizeBenchmarks(results);
  const report = {
    generatedAt: new Date().toISOString(),
    options,
    summary,
    results,
  };
  const summaryPath = path.join(options.artifactsDir, "summary.json");
  await fs.writeFile(summaryPath, JSON.stringify(report, null, 2), "utf-8");

  if (options.output === "json") {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printTable(summary, results, options.artifactsDir);
  console.log(`Summary JSON: ${summaryPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
