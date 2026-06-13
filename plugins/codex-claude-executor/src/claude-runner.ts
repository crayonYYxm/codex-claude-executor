/**
 * Claude runner module for subprocess management.
 *
 * Handles invoking Claude Code CLI, capturing output,
 * managing timeouts, and parsing results.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type {
  ClaudeRunResult,
  ExecutionMode,
  ExecutionStatus,
  WorkspaceSnapshot,
} from "./types.js";

const MAX_OUTPUT_SIZE = 2 * 1024 * 1024; // 2 MiB
const SIGTERM_WAIT_MS = 5000;
const RESULT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    status: { type: "string", enum: ["success", "error"] },
    summary: { type: "string" },
    error: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
    commandsExecuted: { type: "array", items: { type: "string" } },
    checks: { type: "array", items: { type: "string" } },
  },
  required: ["status", "summary"],
  additionalProperties: false,
});

export type RunClaudeOptions = {
  workingDirectory: string;
  plan: string;
  acceptanceCriteria?: string[];
  allowedTools: string[];
  executionMode?: ExecutionMode;
  timeoutSeconds: number;
  workspaceBefore: WorkspaceSnapshot;
  claudeBin?: string;
  env?: Record<string, string>;
};

export type RunningClaude = {
  cancel: () => void;
  completed: Promise<ClaudeRunResult>;
  getPid: () => number | null;
};

export type StartClaudeHooks = {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onProgress?: (event: ClaudeProgressEvent) => void;
};

export type ClaudeProgressEvent = {
  message: string;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function parseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseClaudeOutput(stdout: string): unknown | null {
  const wholeOutput = parseJsonLine(stdout);
  if (wholeOutput !== null) {
    return wholeOutput;
  }

  const lines = stdout.trim().split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const parsed = parseJsonLine(lines[index]);
    if (isRecord(parsed) && parsed.type === "result") {
      return parsed;
    }
  }
  return null;
}

function isClaudeErrorResult(value: unknown): boolean {
  const structuredOutput = isRecord(value) ? value.structured_output : null;
  return (
    isRecord(value) &&
    ((value.type === "result" &&
      (value.is_error === true || value.subtype === "error")) ||
      (isRecord(structuredOutput) && structuredOutput.status === "error"))
  );
}

function isClaudeSuccessResult(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "result" &&
    value.is_error !== true &&
    isRecord(value.structured_output) &&
    value.structured_output.status === "success"
  );
}

function getClaudeErrorMessage(value: unknown): string {
  if (isRecord(value) && isRecord(value.structured_output)) {
    const structuredOutput = value.structured_output;
    if (typeof structuredOutput.error === "string") {
      return `Claude reported an error: ${structuredOutput.error}`;
    }
    if (typeof structuredOutput.summary === "string") {
      return `Claude reported an error: ${structuredOutput.summary}`;
    }
  }
  if (isRecord(value) && typeof value.result === "string") {
    return `Claude reported an error: ${value.result}`;
  }
  return "Claude reported an error";
}

function summarizeToolInput(input: unknown): string | null {
  if (!isRecord(input)) return null;
  const keys = ["description", "file_path", "path", "command", "pattern", "query"];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().replace(/\s+/g, " ").slice(0, 180);
    }
  }
  return null;
}

function getContentBlocks(event: JsonRecord): unknown[] {
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return [];
  }
  return message.content;
}

function emitProgressFromEvent(
  event: unknown,
  toolNames: Map<string, string>,
  onProgress?: (event: ClaudeProgressEvent) => void
): void {
  if (!onProgress || !isRecord(event)) return;

  if (event.type === "system" && event.subtype === "init") {
    onProgress({ message: "Claude started" });
    return;
  }

  if (event.type === "result") {
    onProgress({
      message: isClaudeErrorResult(event)
        ? "Claude reported an error"
        : "Claude finished",
    });
    return;
  }

  for (const block of getContentBlocks(event)) {
    if (!isRecord(block)) continue;

    if (
      event.type === "assistant" &&
      block.type === "tool_use" &&
      typeof block.name === "string"
    ) {
      if (typeof block.id === "string") {
        toolNames.set(block.id, block.name);
      }
      const detail = summarizeToolInput(block.input);
      onProgress({
        message: `Using ${block.name}${detail ? `: ${detail}` : ""}`,
      });
    } else if (
      event.type === "user" &&
      block.type === "tool_result" &&
      typeof block.tool_use_id === "string"
    ) {
      const toolName = toolNames.get(block.tool_use_id) ?? "tool";
      toolNames.delete(block.tool_use_id);
      onProgress({
        message: `${block.is_error === true ? "Failed" : "Completed"} ${toolName}`,
      });
    } else if (
      event.type === "assistant" &&
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trim()
    ) {
      onProgress({
        message: block.text.trim().replace(/\s+/g, " ").slice(0, 240),
      });
    }
  }
}

/**
 * Build the execution prompt for Claude.
 */
function buildPrompt(options: RunClaudeOptions): string {
  const executionMode = options.executionMode ?? "standard";
  const sections: string[] = [
    "This is an already approved implementation plan.",
    "",
    `Working directory: ${options.workingDirectory}`,
    "",
    "## Plan",
    options.plan,
    "",
    "## Workspace Before Execution",
    JSON.stringify(options.workspaceBefore, null, 2),
  ];

  if (options.acceptanceCriteria && options.acceptanceCriteria.length > 0) {
    sections.push("", "## Acceptance Criteria");
    for (const criteria of options.acceptanceCriteria) {
      sections.push(`- ${criteria}`);
    }
  }

  sections.push(
    "",
    "## Instructions",
    "- Preserve all pre-existing user changes.",
    "- Do not revert, reset, clean, checkout, commit, push, or deploy.",
    "- Do not modify unrelated files.",
    "- Do not access files outside the working directory.",
    "- Run relevant tests, builds, and linters when allowed by the tool permissions.",
    "- Do not run previews or browser verification; Codex will perform visual and browser checks.",
    "- Return status `error` if implementation cannot be completed or any required test, build, lint, or typecheck fails.",
    "",
    "## Reporting",
    "At the end, report:",
    "- Changed files",
    "- Commands executed",
    "- Test, build, and lint results",
    "- Unresolved issues"
  );

  if (executionMode === "claude_write_only") {
    sections.push(
      "",
      "## Collaboration Mode",
      "- Codex is acting as planner and reviewer only.",
      "- Claude must perform every code change inside this execution.",
      "- Do not assume Codex will manually patch your output after this run.",
      "- If the review later finds issues, expect a follow-up plan instead of a manual Codex fix."
    );
  }

  return sections.join("\n");
}

/**
 * Run Claude Code CLI with the given plan.
 *
 * Uses spawn without shell, sends prompt via stdin,
 * captures stdout/stderr with size limits.
 */
export function startClaude(
  options: RunClaudeOptions,
  hooks: StartClaudeHooks = {}
): RunningClaude {
  const claudeBin = options.claudeBin ?? process.env.CLAUDE_BIN ?? "claude";
  const startTime = Date.now();

  // Build Claude arguments
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--no-chrome",
    "--json-schema",
    RESULT_SCHEMA,
    "--allowedTools",
    options.allowedTools.join(","),
  ];

  // Build environment
  const env = { ...process.env, ...options.env };

  // Build prompt
  const prompt = buildPrompt(options);

  let process_ref: ChildProcess | null = null;
  let processClosed = false;
  let stopReason: "timeout" | "cancelled" | null = null;

  const completed = new Promise<ClaudeRunResult>((resolve) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let sigtermTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let resolved = false;
    let stdoutLineBuffer = "";
    let stdoutLineOverflow = false;
    let finalResultEvent: unknown | null = null;
    const toolNames = new Map<string, string>();

    const consumeStdoutLine = (line: string) => {
      const event = parseJsonLine(line);
      if (isRecord(event) && event.type === "result") {
        finalResultEvent = event;
      }
      emitProgressFromEvent(event, toolNames, hooks.onProgress);
    };
    const consumeStdoutChunk = (chunk: string) => {
      if (stdoutLineOverflow) {
        const newlineIndex = chunk.search(/\r?\n/);
        if (newlineIndex < 0) return;
        stdoutLineOverflow = false;
        chunk = chunk.slice(newlineIndex + 1);
      }

      stdoutLineBuffer += chunk;
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        consumeStdoutLine(line);
      }
      if (Buffer.byteLength(stdoutLineBuffer) > MAX_OUTPUT_SIZE) {
        stdoutLineBuffer = "";
        stdoutLineOverflow = true;
      }
    };

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (sigtermTimeoutId) {
        clearTimeout(sigtermTimeoutId);
        sigtermTimeoutId = null;
      }
    };

    const resolveOnce = (result: ClaudeRunResult) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(result);
      }
    };

    const signalProcess = (signal: NodeJS.Signals) => {
      if (!process_ref?.pid || processClosed) return;

      // detached creates a separate process group on macOS/Linux. Signalling
      // the group also stops child commands spawned by Claude.
      if (process.platform !== "win32") {
        try {
          process.kill(-process_ref.pid, signal);
          return;
        } catch {
          // Fall back to signalling the direct child.
        }
      }
      process_ref.kill(signal);
    };

    try {
      process_ref = spawn(claudeBin, args, {
        cwd: options.workingDirectory,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        env,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolveOnce({
        status: "environment_error",
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startTime,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        parsedOutput: null,
        error: `Failed to spawn Claude process: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    // Send prompt via stdin then close
    process_ref.stdin?.write(prompt);
    process_ref.stdin?.end();

    // Capture stdout with size limit
    process_ref.stdout?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      hooks.onStdout?.(chunk);
      consumeStdoutChunk(chunk);
      if (stdout.length < MAX_OUTPUT_SIZE) {
        stdout += chunk;
        if (stdout.length > MAX_OUTPUT_SIZE) {
          stdout = stdout.slice(0, MAX_OUTPUT_SIZE);
          stdoutTruncated = true;
        }
      } else {
        stdoutTruncated = true;
      }
    });

    // Capture stderr with size limit
    process_ref.stderr?.on("data", (data: Buffer) => {
      const chunk = data.toString();
      hooks.onStderr?.(chunk);
      if (stderr.length < MAX_OUTPUT_SIZE) {
        stderr += chunk;
        if (stderr.length > MAX_OUTPUT_SIZE) {
          stderr = stderr.slice(0, MAX_OUTPUT_SIZE);
          stderrTruncated = true;
        }
      } else {
        stderrTruncated = true;
      }
    });

    // A zero timeout deliberately disables the subprocess deadline. Background
    // jobs remain cancellable through cancel_execution.
    if (options.timeoutSeconds > 0) {
      timeoutId = setTimeout(() => {
        stopReason = "timeout";

        // Send SIGTERM
        signalProcess("SIGTERM");

        // Wait 5 seconds then SIGKILL
        sigtermTimeoutId = setTimeout(() => {
          signalProcess("SIGKILL");
        }, SIGTERM_WAIT_MS);
      }, options.timeoutSeconds * 1000);
    }

    // Wait for close rather than exit so stdout/stderr are fully drained.
    process_ref.on("close", (code, signal) => {
      processClosed = true;
      if (resolved) return;
      cleanup();

      const durationMs = Date.now() - startTime;
      if (stdoutLineBuffer.trim()) {
        consumeStdoutLine(stdoutLineBuffer);
      }

      // If timeout was triggered, report timed_out regardless of exit code
      if (stopReason === "timeout") {
        resolveOnce({
          status: "timed_out",
          exitCode: code,
          signal: signal as NodeJS.Signals | null,
          durationMs,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          parsedOutput: null,
          error: `Execution timed out after ${options.timeoutSeconds} seconds`,
        });
        return;
      }

      if (stopReason === "cancelled") {
        resolveOnce({
          status: "cancelled",
          exitCode: code,
          signal: signal as NodeJS.Signals | null,
          durationMs,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          parsedOutput: null,
          error: "Execution was cancelled",
        });
        return;
      }

      // Try to parse stdout as JSON
      let parsedOutput: unknown | null = null;
      let parseError: string | null = null;

      parsedOutput = finalResultEvent ?? parseClaudeOutput(stdout);
      if (code === 0 && parsedOutput === null) {
        parseError = "Invalid JSON output from Claude despite zero exit code";
      }

      // Determine status
      let status: ExecutionStatus;
      let error: string | null = parseError;

      if (code === 0 && isClaudeSuccessResult(parsedOutput)) {
        status = "completed";
      } else if (code === 0 && isClaudeErrorResult(parsedOutput)) {
        status = "failed";
        error = getClaudeErrorMessage(parsedOutput);
      } else if (code === 0) {
        status = "failed";
        error =
          parseError ??
          "Claude did not return the required final structured success result";
      } else {
        status = "failed";
        if (!error) {
          error = `Claude process exited with code ${code}`;
        }
      }

      resolveOnce({
        status,
        exitCode: code,
        signal: signal as NodeJS.Signals | null,
        durationMs,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        parsedOutput,
        error,
      });
    });

    // Handle spawn errors
    process_ref.on("error", (error) => {
      if (resolved) return;
      cleanup();

      resolveOnce({
        status: "environment_error",
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startTime,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        parsedOutput: null,
        error: `Failed to spawn Claude process: ${error.message}`,
      });
    });
  });

  return {
    cancel: () => {
      if (processClosed || stopReason === "timeout" || stopReason === "cancelled") {
        return;
      }
      stopReason = "cancelled";
      if (!process_ref?.pid) {
        return;
      }
      if (process.platform !== "win32") {
        try {
          process.kill(-process_ref.pid, "SIGTERM");
        } catch {
          process_ref.kill("SIGTERM");
        }
      } else {
        process_ref.kill("SIGTERM");
      }
      setTimeout(() => {
        if (!processClosed) {
          if (process.platform !== "win32") {
            try {
              process.kill(-process_ref!.pid!, "SIGKILL");
            } catch {
              process_ref?.kill("SIGKILL");
            }
          } else {
            process_ref?.kill("SIGKILL");
          }
        }
      }, SIGTERM_WAIT_MS);
    },
    completed,
    getPid: () => process_ref?.pid ?? null,
  };
}

export async function runClaude(
  options: RunClaudeOptions
): Promise<ClaudeRunResult> {
  return startClaude(options).completed;
}
