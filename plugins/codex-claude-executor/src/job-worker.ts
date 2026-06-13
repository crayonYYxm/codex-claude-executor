import * as fs from "node:fs/promises";
import { startClaude } from "./claude-runner.js";
import { captureWorkspaceSnapshot } from "./workspace.js";
import {
  appendCappedLog,
  atomicWriteJson,
  isTerminalStatus,
  jobPath,
  readRequest,
  readStatus,
  removeWorkspaceLock,
  safeWorkspaceSnapshot,
  writeResult,
  writeStatus,
} from "./job-store.js";
import type {
  ClaudeRunResult,
  ExecutePlanResult,
  ExecutionJobStatusResult,
  FailureKind,
} from "./types.js";

const root = process.argv[2];
const jobId = process.argv[3];
if (!root || !jobId) {
  console.error("Usage: job-worker <job-root> <job-id>");
  process.exit(1);
}

let cancelled = false;
let currentRun: ReturnType<typeof startClaude> | null = null;
process.on("SIGTERM", () => {
  cancelled = true;
  currentRun?.cancel();
});
process.on("SIGINT", () => {
  cancelled = true;
  currentRun?.cancel();
});

function failureKindFor(result: ClaudeRunResult): FailureKind {
  if (result.status === "environment_error") return "worker_error";
  if (
    result.error?.includes("structured success") ||
    result.error?.includes("Invalid JSON")
  ) {
    return "invalid_result";
  }
  return result.status === "failed" ? "claude_error" : null;
}

async function main(): Promise<void> {
  const startFlag = jobPath(root, jobId, "start.flag");
  const cancelFlag = jobPath(root, jobId, "cancel.flag");
  const startDeadline = Date.now() + 5000;
  while (Date.now() < startDeadline) {
    try {
      await fs.access(startFlag);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const request = await readRequest(root, jobId);
  let status = await readStatus(root, jobId);
  try {
    await fs.access(cancelFlag);
    cancelled = true;
  } catch {
    // No cancellation was requested before worker startup.
  }
  const stdoutPath = jobPath(root, jobId, "stdout.log");
  const stderrPath = jobPath(root, jobId, "stderr.log");
  let logQueue = Promise.resolve();
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let persistQueue = Promise.resolve();
  let lastActivityPersistedAt = 0;

  const persist = () => {
    persistQueue = persistQueue.then(() => writeStatus(root, jobId, status));
    return persistQueue;
  };
  const activity = (message?: string) => {
    status.lastActivityAt = new Date().toISOString();
    if (message) {
      status.progress = {
        eventCount: (status.progress?.eventCount ?? 0) + 1,
        message,
        updatedAt: status.lastActivityAt,
      };
    }
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      currentRun?.cancel();
    }, request.stallMs);
    if (Date.now() - lastActivityPersistedAt >= 250) {
      lastActivityPersistedAt = Date.now();
      void persist();
    }
  };
  const append = (stream: "stdout" | "stderr", chunk: string) => {
    activity();
    const filePath = stream === "stdout" ? stdoutPath : stderrPath;
    logQueue = logQueue.then(async () => {
      const truncated = await appendCappedLog(
        filePath,
        chunk,
        request.logLimitBytes
      );
      if (truncated) status.logsTruncated[stream] = true;
    });
  };

  try {
    while (status.attempt < status.maxAttempts && !cancelled) {
      status.attempt += 1;
      status.status = "running";
      status.workerPid = process.pid;
      status.currentPid = null;
      status.failureKind = null;
      activity(`Claude attempt ${status.attempt} started`);
      await persist();

      currentRun = startClaude(
        {
          workingDirectory: request.workingDirectory,
          plan: request.plan,
          acceptanceCriteria: request.acceptanceCriteria,
          allowedTools: request.allowedTools,
          executionMode: request.executionMode,
          timeoutSeconds: 0,
          workspaceBefore: request.workspaceBefore,
          claudeBin: request.claudeBin,
          env: request.env,
        },
        {
          onStdout: (chunk) => append("stdout", chunk),
          onStderr: (chunk) => append("stderr", chunk),
          onProgress: (event) => activity(event.message),
        }
      );
      status.currentPid = currentRun.getPid();
      await persist();
      const runResult = await currentRun.completed;
      currentRun = null;
      if (stallTimer) clearTimeout(stallTimer);
      await logQueue;
      await persistQueue;

      if (cancelled && !stalled) {
        await finish({
          ...runResult,
          status: "cancelled",
          error: "Execution was cancelled",
        }, null);
        return;
      }

      if (stalled) {
        if (status.attempt < status.maxAttempts) {
          status.status = "restarting";
          status.failureKind = "stalled";
          status.progress = {
            eventCount: (status.progress?.eventCount ?? 0) + 1,
            message: `Claude stalled; restarting attempt ${status.attempt + 1} of ${status.maxAttempts}`,
            updatedAt: new Date().toISOString(),
          };
          stalled = false;
          await persist();
          continue;
        }
        await finish(
          {
            ...runResult,
            status: "failed",
            error: `Claude made no progress for ${request.stallMs}ms across ${status.maxAttempts} attempts. Last progress: ${status.progress?.message ?? "none"}. Logs: ${stdoutPath}, ${stderrPath}`,
          },
          "stalled"
        );
        return;
      }

      await finish(runResult, failureKindFor(runResult));
      return;
    }

    if (cancelled) {
      await finish(
        {
          status: "cancelled",
          exitCode: null,
          signal: "SIGTERM",
          durationMs: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          parsedOutput: null,
          error: "Execution was cancelled",
        },
        null
      );
    }
  } catch (error) {
    const fallback: ClaudeRunResult = {
      status: "environment_error",
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      parsedOutput: null,
      error: `Worker failed: ${error instanceof Error ? error.message : String(error)}`,
    };
    await finish(fallback, "worker_error");
  }

  async function finish(
    runResult: ClaudeRunResult,
    failureKind: FailureKind
  ): Promise<void> {
    if (stallTimer) clearTimeout(stallTimer);
    const workspaceAfter = await safeWorkspaceSnapshot(
      request.workingDirectory,
      captureWorkspaceSnapshot
    );
    const result: ExecutePlanResult = {
      ...runResult,
      jobId,
      workingDirectory: request.workingDirectory,
      allowedTools: request.allowedTools,
      executionMode: request.executionMode,
      workspaceBefore: request.workspaceBefore,
      workspaceAfter,
    };
    status = {
      ...status,
      status: result.status,
      finishedAt: new Date().toISOString(),
      workspaceAfter,
      result,
      currentPid: null,
      workerPid: null,
      failureKind,
    };
    await writeResult(root, jobId, result);
    await writeStatus(root, jobId, status);
    await removeWorkspaceLock(root, request.workingDirectory, jobId);
  }
}

main().catch(async (error) => {
  try {
    const status = await readStatus(root, jobId);
    if (!isTerminalStatus(status.status)) {
      const workspaceAfter = await safeWorkspaceSnapshot(
        status.workingDirectory,
        captureWorkspaceSnapshot
      );
      const message = `Worker failed: ${error instanceof Error ? error.message : String(error)}`;
      status.status = "environment_error";
      status.failureKind = "worker_error";
      status.finishedAt = new Date().toISOString();
      status.workerPid = null;
      status.currentPid = null;
      status.workspaceAfter = workspaceAfter;
      status.result = {
        jobId,
        status: "environment_error",
        exitCode: null,
        signal: null,
        durationMs: 0,
        stdout: "",
        stderr: "",
        stdoutTruncated: status.logsTruncated.stdout,
        stderrTruncated: status.logsTruncated.stderr,
        parsedOutput: null,
        error: message,
        workingDirectory: status.workingDirectory,
        allowedTools: status.allowedTools,
        executionMode: status.executionMode,
        workspaceBefore: status.workspaceBefore,
        workspaceAfter,
      };
      await writeResult(root, jobId, status.result);
      await atomicWriteJson(jobPath(root, jobId, "status.json"), status);
      await removeWorkspaceLock(root, status.workingDirectory, jobId);
    }
  } finally {
    console.error(error);
    process.exit(1);
  }
});
