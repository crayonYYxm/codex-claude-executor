import * as fs from "node:fs/promises";
import { createWriteStream, type WriteStream } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { startClaude, type RunClaudeOptions } from "./claude-runner.js";
import { captureWorkspaceSnapshot } from "./workspace.js";
import type {
  ExecutePlanResult,
  ExecutionJobStatusResult,
  ExecutionLogResult,
  ExecutionLogStream,
  JobStatus,
  StartExecutionResult,
  WorkspaceSnapshot,
} from "./types.js";

type StartExecutionOptions = RunClaudeOptions;

type ExecutionJob = {
  id: string;
  status: JobStatus;
  workingDirectory: string;
  allowedTools: string[];
  timeoutSeconds: number;
  createdAt: string;
  startedAt: string;
  finishedAt: string | null;
  workspaceBefore: WorkspaceSnapshot;
  workspaceAfter: WorkspaceSnapshot | null;
  result: ExecutePlanResult | null;
  currentPid: number | null;
  stdoutPath: string;
  stderrPath: string;
  statusPath: string;
  resultPath: string;
  stdoutStream: WriteStream;
  stderrStream: WriteStream;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutText: string;
  stderrText: string;
  runner: ReturnType<typeof startClaude> | null;
  completionPromise: Promise<void>;
};

async function ensureDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
}

function toStatusResult(job: ExecutionJob): ExecutionJobStatusResult {
  return {
    jobId: job.id,
    status: job.status,
    workingDirectory: job.workingDirectory,
    allowedTools: [...job.allowedTools],
    timeoutSeconds: job.timeoutSeconds,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    workspaceBefore: job.workspaceBefore,
    workspaceAfter: job.workspaceAfter,
    result: job.result,
    currentPid: job.currentPid,
  };
}

export class ExecutionJobManager {
  private readonly jobs = new Map<string, ExecutionJob>();
  private readonly rootDirectory: string;

  constructor(rootDirectory?: string) {
    this.rootDirectory =
      rootDirectory ?? path.join(os.tmpdir(), "codex-claude-executor-jobs");
  }

  private async persistStatus(job: ExecutionJob): Promise<void> {
    await fs.writeFile(
      job.statusPath,
      JSON.stringify(toStatusResult(job), null, 2),
      "utf-8"
    );
  }

  private getActiveJob(): ExecutionJob | undefined {
    for (const job of this.jobs.values()) {
      if (job.status === "running" || job.status === "cancelling") {
        return job;
      }
    }
    return undefined;
  }

  async startExecution(
    options: StartExecutionOptions
  ): Promise<StartExecutionResult> {
    const activeJob = this.getActiveJob();
    if (activeJob) {
      throw new Error(
        `Another execution is already active (${activeJob.id}). Wait for it to finish or cancel it first.`
      );
    }

    const jobId = randomUUID();
    const createdAt = new Date().toISOString();
    const startedAt = createdAt;
    const jobDirectory = path.join(this.rootDirectory, jobId);
    await ensureDirectory(jobDirectory);

    const stdoutPath = path.join(jobDirectory, "stdout.log");
    const stderrPath = path.join(jobDirectory, "stderr.log");
    const statusPath = path.join(jobDirectory, "status.json");
    const resultPath = path.join(jobDirectory, "result.json");
    await fs.writeFile(stdoutPath, "", "utf-8");
    await fs.writeFile(stderrPath, "", "utf-8");

    const stdoutStream = createWriteStream(stdoutPath, { flags: "a" });
    const stderrStream = createWriteStream(stderrPath, { flags: "a" });

    const job: ExecutionJob = {
      id: jobId,
      status: "running",
      workingDirectory: options.workingDirectory,
      allowedTools: [...options.allowedTools],
      timeoutSeconds: options.timeoutSeconds,
      createdAt,
      startedAt,
      finishedAt: null,
      workspaceBefore: options.workspaceBefore,
      workspaceAfter: null,
      result: null,
      currentPid: null,
      stdoutPath,
      stderrPath,
      statusPath,
      resultPath,
      stdoutStream,
      stderrStream,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutText: "",
      stderrText: "",
      runner: null,
      completionPromise: Promise.resolve(),
    };

    const runner = startClaude(options, {
      onStdout: (chunk) => {
        job.stdoutBytes += Buffer.byteLength(chunk);
        job.stdoutText += chunk;
        job.stdoutStream.write(chunk);
      },
      onStderr: (chunk) => {
        job.stderrBytes += Buffer.byteLength(chunk);
        job.stderrText += chunk;
        job.stderrStream.write(chunk);
      },
    });
    job.runner = runner;
    job.currentPid = runner.getPid();

    this.jobs.set(jobId, job);
    await this.persistStatus(job);

    job.completionPromise = runner.completed
      .then(async (runResult) => {
        job.finishedAt = new Date().toISOString();
        job.currentPid = null;
        job.workspaceAfter = await captureWorkspaceSnapshot(job.workingDirectory);
        job.status = runResult.status;
        job.result = {
          ...runResult,
          jobId,
          workingDirectory: job.workingDirectory,
          allowedTools: [...job.allowedTools],
          workspaceBefore: job.workspaceBefore,
          workspaceAfter: job.workspaceAfter,
        };
        await fs.writeFile(
          job.resultPath,
          JSON.stringify(job.result, null, 2),
          "utf-8"
        );
        await new Promise<void>((resolve) => job.stdoutStream.end(resolve));
        await new Promise<void>((resolve) => job.stderrStream.end(resolve));
        await this.persistStatus(job);
      })
      .catch(async (error) => {
        job.finishedAt = new Date().toISOString();
        job.currentPid = null;
        job.workspaceAfter = await captureWorkspaceSnapshot(job.workingDirectory);
        job.status = "failed";
        job.result = {
          jobId,
          status: "failed",
          exitCode: null,
          signal: null,
          durationMs: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          parsedOutput: null,
          error: `Unexpected async execution failure: ${error instanceof Error ? error.message : String(error)}`,
          workingDirectory: job.workingDirectory,
          allowedTools: [...job.allowedTools],
          workspaceBefore: job.workspaceBefore,
          workspaceAfter: job.workspaceAfter,
        };
        await new Promise<void>((resolve) => job.stdoutStream.end(resolve));
        await new Promise<void>((resolve) => job.stderrStream.end(resolve));
        await this.persistStatus(job);
      });

    return {
      jobId,
      status: job.status,
      workingDirectory: job.workingDirectory,
      allowedTools: [...job.allowedTools],
      timeoutSeconds: job.timeoutSeconds,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
    };
  }

  async waitForResult(jobId: string): Promise<ExecutePlanResult> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Unknown job: ${jobId}`);
    }
    if (job.result) {
      return job.result;
    }
    if (!job.runner) {
      throw new Error(`Job ${jobId} has no active runner`);
    }
    await job.completionPromise;
    if (job.result) {
      return job.result;
    }
    const runResult = await job.runner.completed;
    return {
      ...runResult,
      jobId,
      workingDirectory: job.workingDirectory,
      allowedTools: [...job.allowedTools],
      workspaceBefore: job.workspaceBefore,
      workspaceAfter:
        job.workspaceAfter ??
        ({
          kind: "non_git",
          note: "Workspace snapshot not available.",
        } as WorkspaceSnapshot),
    };
  }

  getExecutionStatus(jobId: string): ExecutionJobStatusResult {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Unknown job: ${jobId}`);
    }
    return toStatusResult(job);
  }

  async getExecutionLogs(
    jobId: string,
    stream: ExecutionLogStream,
    offset: number,
    limit: number
  ): Promise<ExecutionLogResult> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Unknown job: ${jobId}`);
    }

    const fileContent = stream === "stdout" ? job.stdoutText : job.stderrText;
    const nextOffset = Math.min(offset + limit, fileContent.length);
    const text = fileContent.slice(offset, nextOffset);

    return {
      jobId,
      status: job.status,
      stream,
      offset,
      nextOffset,
      eof: nextOffset >= fileContent.length,
      text,
    };
  }

  async cancelExecution(jobId: string): Promise<ExecutionJobStatusResult> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Unknown job: ${jobId}`);
    }
    if (job.status === "running") {
      job.status = "cancelling";
      await this.persistStatus(job);
      job.runner?.cancel();
    }
    return toStatusResult(job);
  }
}
