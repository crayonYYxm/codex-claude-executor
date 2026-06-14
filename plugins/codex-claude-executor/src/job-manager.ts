import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { RunClaudeOptions } from "./claude-runner.js";
import {
  DEFAULT_JOB_ROOT,
  DEFAULT_LOG_LIMIT_BYTES,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_STALL_MS,
  atomicWriteJson,
  cleanupOldJobs,
  ensureJobRoot,
  isPidAlive,
  isTerminalStatus,
  jobDirectory,
  jobPath,
  readResult,
  readStatus,
  removeWorkspaceLock,
  safeWorkspaceSnapshot,
  workspaceLockPath,
  writeResult,
  writeStatus,
  type PersistedJobRequest,
} from "./job-store.js";
import { captureWorkspaceSnapshot } from "./workspace.js";
import type {
  ExecutionJobStatusResult,
  ExecutionLogResult,
  ExecutionLogStream,
  ExecutePlanResult,
  StartExecutionResult,
} from "./types.js";

type StartExecutionOptions = RunClaudeOptions;

export function resolveWorkerPath(): string {
  return (
    process.env.CLAUDE_EXECUTOR_WORKER_PATH ??
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../dist/job-worker.mjs"
    )
  );
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
    } else {
      process.kill(pid, signal);
    }
  } catch {
    // The worker may have exited between status inspection and signalling.
  }
}

async function terminateProcessGroup(pid: number): Promise<void> {
  signalProcessGroup(pid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (isPidAlive(pid)) signalProcessGroup(pid, "SIGKILL");
}

export class ExecutionJobManager {
  private readonly rootDirectory: string;
  private readonly initialization: Promise<void>;

  constructor(rootDirectory?: string) {
    this.rootDirectory =
      rootDirectory ?? process.env.CLAUDE_EXECUTOR_JOB_ROOT ?? DEFAULT_JOB_ROOT;
    this.initialization = this.initializePersistentJobs();
  }

  private async initializePersistentJobs(): Promise<void> {
    await ensureJobRoot(this.rootDirectory);
    await cleanupOldJobs(this.rootDirectory);
    const entries = await fs.readdir(this.rootDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".locks") continue;
      try {
        await this.recoverIfNeeded(await readStatus(this.rootDirectory, entry.name));
      } catch {
        // A malformed job remains on disk for diagnosis and does not prevent
        // the MCP server from recovering other jobs.
      }
    }
  }

  private async spawnWorker(jobId: string): Promise<number> {
    const child = spawn(process.execPath, [resolveWorkerPath(), this.rootDirectory, jobId], {
      detached: process.platform !== "win32",
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    if (!child.pid) {
      throw new Error(`Failed to start worker for job ${jobId}`);
    }
    return child.pid;
  }

  private async launchWorker(
    status: ExecutionJobStatusResult
  ): Promise<ExecutionJobStatusResult> {
    const startPath = jobPath(this.rootDirectory, status.jobId, "start.flag");
    await fs.rm(startPath, { force: true });
    status.workerPid = await this.spawnWorker(status.jobId);
    await writeStatus(this.rootDirectory, status.jobId, status);
    await fs.writeFile(startPath, "");
    return status;
  }

  private async recoverPersistedTerminalResult(
    status: ExecutionJobStatusResult
  ): Promise<ExecutionJobStatusResult | null> {
    try {
      const persistedResult = await readResult(this.rootDirectory, status.jobId);
      if (!isTerminalStatus(persistedResult.status)) return null;
      status.status = persistedResult.status;
      status.finishedAt = new Date().toISOString();
      status.currentPid = null;
      status.workerPid = null;
      status.workspaceAfter = persistedResult.workspaceAfter;
      status.result = persistedResult;
      await writeStatus(this.rootDirectory, status.jobId, status);
      await removeWorkspaceLock(
        this.rootDirectory,
        status.workingDirectory,
        status.jobId
      );
      return status;
    } catch {
      return null;
    }
  }

  private async completeCancellation(
    status: ExecutionJobStatusResult
  ): Promise<ExecutionJobStatusResult> {
    const workspaceAfter = await safeWorkspaceSnapshot(
      status.workingDirectory,
      captureWorkspaceSnapshot
    );
    status.status = "cancelled";
    status.finishedAt = new Date().toISOString();
    status.currentPid = null;
    status.workerPid = null;
    status.workspaceAfter = workspaceAfter;
    status.result = {
      jobId: status.jobId,
      status: "cancelled",
      exitCode: null,
      signal: "SIGTERM",
      durationMs: 0,
      stdout: "",
      stderr: "",
      stdoutTruncated: status.logsTruncated.stdout,
      stderrTruncated: status.logsTruncated.stderr,
      parsedOutput: null,
      error: "Execution was cancelled",
      workingDirectory: status.workingDirectory,
      allowedTools: status.allowedTools,
      executionMode: status.executionMode,
      workspaceBefore: status.workspaceBefore,
      workspaceAfter,
    };
    await writeResult(this.rootDirectory, status.jobId, status.result);
    await writeStatus(this.rootDirectory, status.jobId, status);
    await removeWorkspaceLock(
      this.rootDirectory,
      status.workingDirectory,
      status.jobId
    );
    return status;
  }

  private async acquireRecoveryLease(
    jobId: string
  ): Promise<{ handle: FileHandle; leasePath: string } | null> {
    const leasePath = jobPath(this.rootDirectory, jobId, "recovery.lock");
    try {
      const handle = await fs.open(leasePath, "wx");
      await handle.writeFile(`${process.pid}\n${Date.now()}`, "utf-8");
      return { handle, leasePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(leasePath);
        if (Date.now() - stat.mtimeMs > 5000) {
          await fs.rm(leasePath, { force: true });
          return this.acquireRecoveryLease(jobId);
        }
      } catch {
        return this.acquireRecoveryLease(jobId);
      }
      return null;
    }
  }

  private async recoverIfNeeded(
    status: ExecutionJobStatusResult
  ): Promise<ExecutionJobStatusResult> {
    if (isTerminalStatus(status.status) || isPidAlive(status.workerPid)) {
      return status;
    }
    const persisted = await this.recoverPersistedTerminalResult(status);
    if (persisted) return persisted;
    if (status.status === "cancelling") {
      return this.completeCancellation(status);
    }

    const lease = await this.acquireRecoveryLease(status.jobId);
    if (!lease) {
      const leasePath = jobPath(this.rootDirectory, status.jobId, "recovery.lock");
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          await fs.access(leasePath);
          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch {
          break;
        }
      }
      return readStatus(this.rootDirectory, status.jobId);
    }

    try {
      status = await readStatus(this.rootDirectory, status.jobId);
      if (isTerminalStatus(status.status) || isPidAlive(status.workerPid)) {
        return status;
      }
      const latestPersisted = await this.recoverPersistedTerminalResult(status);
      if (latestPersisted) return latestPersisted;
      if (status.status === "cancelling") {
        return this.completeCancellation(status);
      }
      if (
        status.recoveryCount >= 2 ||
        status.attempt >= status.maxAttempts
      ) {
        return this.markEnvironmentError(
          status,
          "Persistent worker exited repeatedly and could not be recovered"
        );
      }

      if (status.currentPid) {
        await terminateProcessGroup(status.currentPid);
      }
      status.recoveryCount += 1;
      status.status = "restarting";
      status.progress = {
        eventCount: (status.progress?.eventCount ?? 0) + 1,
        message: `Recovering persistent worker (${status.recoveryCount}/2)`,
        updatedAt: new Date().toISOString(),
      };
      return this.launchWorker(status);
    } finally {
      await lease.handle.close();
      await fs.rm(lease.leasePath, { force: true });
    }
  }

  private async markEnvironmentError(
    status: ExecutionJobStatusResult,
    message: string
  ): Promise<ExecutionJobStatusResult> {
    const workspaceAfter = await safeWorkspaceSnapshot(
      status.workingDirectory,
      captureWorkspaceSnapshot
    );
    status.status = "environment_error";
    status.finishedAt = new Date().toISOString();
    status.failureKind = "worker_error";
    status.currentPid = null;
    status.workerPid = null;
    status.workspaceAfter = workspaceAfter;
    status.progress = {
      eventCount: (status.progress?.eventCount ?? 0) + 1,
      message,
      updatedAt: new Date().toISOString(),
    };
    status.result = {
      jobId: status.jobId,
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
    await writeResult(this.rootDirectory, status.jobId, status.result);
    await writeStatus(this.rootDirectory, status.jobId, status);
    await removeWorkspaceLock(
      this.rootDirectory,
      status.workingDirectory,
      status.jobId
    );
    return status;
  }

  private async acquireWorkspaceLock(
    workingDirectory: string,
    jobId: string
  ): Promise<void> {
    const lockPath = workspaceLockPath(this.rootDirectory, workingDirectory);
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(jobId, "utf-8");
      await handle.close();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const activeJobId = (await fs.readFile(lockPath, "utf-8")).trim();
    try {
      const status = await this.recoverIfNeeded(
        await readStatus(this.rootDirectory, activeJobId)
      );
      if (!isTerminalStatus(status.status)) {
        throw new Error(
          `Another execution is already active for this workspace (${activeJobId}).`
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("already active for this workspace")
      ) {
        throw error;
      }
    }

    await fs.rm(lockPath, { force: true });
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(jobId, "utf-8");
    await handle.close();
  }

  async startExecution(
    options: StartExecutionOptions
  ): Promise<StartExecutionResult> {
    await this.initialization;

    const jobId = randomUUID();
    await this.acquireWorkspaceLock(options.workingDirectory, jobId);
    let status: ExecutionJobStatusResult | null = null;
    try {
      const directory = jobDirectory(this.rootDirectory, jobId);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(jobPath(this.rootDirectory, jobId, "stdout.log"), "");
      await fs.writeFile(jobPath(this.rootDirectory, jobId, "stderr.log"), "");

      const request: PersistedJobRequest = {
        workingDirectory: options.workingDirectory,
        plan: options.plan,
        acceptanceCriteria: options.acceptanceCriteria ?? [],
        extraAllowedTools: [],
        allowedTools: [...options.allowedTools],
        executionMode: options.executionMode ?? "standard",
        timeoutSeconds: 0,
        workspaceBefore: options.workspaceBefore,
        claudeBin: options.claudeBin,
        env: options.env,
        stallMs: Number(process.env.CLAUDE_EXECUTOR_STALL_MS) || DEFAULT_STALL_MS,
        maxAttempts:
          Number(process.env.CLAUDE_EXECUTOR_MAX_ATTEMPTS) || DEFAULT_MAX_ATTEMPTS,
        logLimitBytes:
          Number(process.env.CLAUDE_EXECUTOR_LOG_LIMIT_BYTES) ||
          DEFAULT_LOG_LIMIT_BYTES,
      };
      await atomicWriteJson(
        jobPath(this.rootDirectory, jobId, "request.json"),
        request
      );

      const now = new Date().toISOString();
      status = {
        jobId,
        status: "running",
        workingDirectory: options.workingDirectory,
        allowedTools: [...options.allowedTools],
        executionMode: options.executionMode ?? "standard",
        timeoutSeconds: 0,
        createdAt: now,
        startedAt: now,
        finishedAt: null,
        workspaceBefore: options.workspaceBefore,
        workspaceAfter: null,
        result: null,
        currentPid: null,
        workerPid: null,
        progress: null,
        attempt: 0,
        maxAttempts: request.maxAttempts,
        lastActivityAt: now,
        recoveryCount: 0,
        failureKind: null,
        logsTruncated: { stdout: false, stderr: false },
      };
      await writeStatus(this.rootDirectory, jobId, status);
      await this.launchWorker(status);

      return {
        jobId,
        status: status.status,
        workingDirectory: status.workingDirectory,
        allowedTools: status.allowedTools,
        executionMode: status.executionMode,
        timeoutSeconds: status.timeoutSeconds,
        createdAt: status.createdAt,
        startedAt: status.startedAt,
      };
    } catch (error) {
      if (status?.workerPid) {
        await terminateProcessGroup(status.workerPid);
      }
      await fs.rm(jobDirectory(this.rootDirectory, jobId), {
        recursive: true,
        force: true,
      });
      await removeWorkspaceLock(
        this.rootDirectory,
        options.workingDirectory,
        jobId
      );
      throw error;
    }
  }

  async waitForResult(jobId: string): Promise<ExecutePlanResult> {
    await this.initialization;
    while (true) {
      const status = await this.getExecutionStatus(jobId);
      if (isTerminalStatus(status.status)) {
        if (!status.result) {
          throw new Error(`Job ${jobId} reached ${status.status} without a result`);
        }
        return status.result;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async waitForResultOrStatus(
    jobId: string,
    maxWaitMs: number
  ): Promise<ExecutePlanResult | ExecutionJobStatusResult> {
    await this.initialization;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const status = await this.getExecutionStatus(jobId);
      if (isTerminalStatus(status.status) && status.result) return status.result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.getExecutionStatus(jobId);
  }

  async getExecutionStatus(jobId: string): Promise<ExecutionJobStatusResult> {
    await this.initialization;
    try {
      return await this.recoverIfNeeded(await readStatus(this.rootDirectory, jobId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Unknown job: ${jobId}`);
      }
      throw error;
    }
  }

  async getExecutionLogs(
    jobId: string,
    stream: ExecutionLogStream,
    offset: number,
    limit: number
  ): Promise<ExecutionLogResult> {
    await this.initialization;
    const status = await this.getExecutionStatus(jobId);
    const filePath = jobPath(this.rootDirectory, jobId, `${stream}.log`);
    const handle = await fs.open(filePath, "r");
    try {
      const stat = await handle.stat();
      const safeOffset = Math.min(offset, stat.size);
      const length = Math.min(limit, stat.size - safeOffset);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, safeOffset);
      return {
        jobId,
        status: status.status,
        stream,
        offset: safeOffset,
        nextOffset: safeOffset + length,
        eof: safeOffset + length >= stat.size,
        text: buffer.toString("utf-8"),
      };
    } finally {
      await handle.close();
    }
  }

  async cancelExecution(
    jobId: string,
    userRequested = false
  ): Promise<ExecutionJobStatusResult> {
    await this.initialization;
    const status = await this.getExecutionStatus(jobId);
    if (status.executionMode === "claude_write_only" && !userRequested) {
      throw new Error(
        "Cancelling a claude_write_only job requires an explicit user request"
      );
    }
    if (!isTerminalStatus(status.status)) {
      status.status = "cancelling";
      await fs.writeFile(jobPath(this.rootDirectory, jobId, "cancel.flag"), "");
      await writeStatus(this.rootDirectory, jobId, status);
      if (status.workerPid) signalProcessGroup(status.workerPid, "SIGTERM");
    }
    return status;
  }
}
