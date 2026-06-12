/**
 * Claude runner module for subprocess management.
 *
 * Handles invoking Claude Code CLI, capturing output,
 * managing timeouts, and parsing results.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type {
  ClaudeRunResult,
  ExecutionStatus,
  WorkspaceSnapshot,
} from "./types.js";

const MAX_OUTPUT_SIZE = 2 * 1024 * 1024; // 2 MiB
const SIGTERM_WAIT_MS = 5000;

export type RunClaudeOptions = {
  workingDirectory: string;
  plan: string;
  acceptanceCriteria?: string[];
  allowedTools: string[];
  timeoutSeconds: number;
  workspaceBefore: WorkspaceSnapshot;
  claudeBin?: string;
  env?: Record<string, string>;
};

/**
 * Build the execution prompt for Claude.
 */
function buildPrompt(options: RunClaudeOptions): string {
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
    "- Run relevant tests only when allowed by the tool permissions.",
    "",
    "## Reporting",
    "At the end, report:",
    "- Changed files",
    "- Commands executed",
    "- Test results",
    "- Unresolved issues"
  );

  return sections.join("\n");
}

/**
 * Run Claude Code CLI with the given plan.
 *
 * Uses spawn without shell, sends prompt via stdin,
 * captures stdout/stderr with size limits.
 */
export async function runClaude(
  options: RunClaudeOptions
): Promise<ClaudeRunResult> {
  const claudeBin = options.claudeBin ?? process.env.CLAUDE_BIN ?? "claude";
  const startTime = Date.now();

  // Build Claude arguments
  const args = [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--no-chrome",
    "--allowedTools",
    options.allowedTools.join(","),
  ];

  // Build environment
  const env = { ...process.env, ...options.env };

  // Build prompt
  const prompt = buildPrompt(options);

  return new Promise<ClaudeRunResult>((resolve) => {
    let process_ref: ChildProcess | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let sigtermTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let resolved = false;
    let timedOut = false; // Track if timeout was triggered
    let processClosed = false;

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
      if (stdout.length < MAX_OUTPUT_SIZE) {
        stdout += data.toString();
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
      if (stderr.length < MAX_OUTPUT_SIZE) {
        stderr += data.toString();
        if (stderr.length > MAX_OUTPUT_SIZE) {
          stderr = stderr.slice(0, MAX_OUTPUT_SIZE);
          stderrTruncated = true;
        }
      } else {
        stderrTruncated = true;
      }
    });

    // Set timeout
    timeoutId = setTimeout(() => {
      timedOut = true;

      // Send SIGTERM
      signalProcess("SIGTERM");

      // Wait 5 seconds then SIGKILL
      sigtermTimeoutId = setTimeout(() => {
        signalProcess("SIGKILL");
      }, SIGTERM_WAIT_MS);
    }, options.timeoutSeconds * 1000);

    // Wait for close rather than exit so stdout/stderr are fully drained.
    process_ref.on("close", (code, signal) => {
      processClosed = true;
      if (resolved) return;
      cleanup();

      const durationMs = Date.now() - startTime;

      // If timeout was triggered, report timed_out regardless of exit code
      if (timedOut) {
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

      // Try to parse stdout as JSON
      let parsedOutput: unknown | null = null;
      let parseError: string | null = null;

      try {
        parsedOutput = JSON.parse(stdout);
      } catch {
        // If exit code is 0 but JSON is invalid, that's an error
        if (code === 0) {
          parseError = "Invalid JSON output from Claude despite zero exit code";
        }
      }

      // Determine status
      let status: ExecutionStatus;
      let error: string | null = parseError;

      if (code === 0 && parsedOutput !== null) {
        status = "completed";
      } else if (code === 0 && parseError) {
        status = "failed";
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
}
