import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ExecutionJobManager } from "../src/job-manager.js";
import {
  isPidAlive,
  jobDirectory,
  writeResult,
  writeStatus,
} from "../src/job-store.js";
import type { WorkspaceSnapshot } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE_SOURCE = path.join(__dirname, "fixtures", "fake-claude.mjs");
const SNAPSHOT: WorkspaceSnapshot = {
  kind: "non_git",
  note: "test workspace",
};

describe("persistent job manager", () => {
  let rootDirectory: string;
  let workspaceA: string;
  let workspaceB: string;
  let fakeClaude: string;

  beforeEach(async () => {
    rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "job-manager-"));
    workspaceA = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-a-"));
    workspaceB = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-b-"));
    fakeClaude = path.join(rootDirectory, "fake-claude.mjs");
    await fs.copyFile(FAKE_CLAUDE_SOURCE, fakeClaude);
    await fs.chmod(fakeClaude, 0o755);
  });

  afterEach(async () => {
    await fs.rm(rootDirectory, { recursive: true, force: true });
    await fs.rm(workspaceA, { recursive: true, force: true });
    await fs.rm(workspaceB, { recursive: true, force: true });
  });

  function startOptions(workingDirectory: string) {
    return {
      workingDirectory,
      plan: "Long-running test plan",
      acceptanceCriteria: [],
      allowedTools: ["Read"],
      executionMode: "standard" as const,
      timeoutSeconds: 0,
      workspaceBefore: SNAPSHOT,
      claudeBin: fakeClaude,
      env: { FAKE_CLAUDE_MODE: "slow-success" },
    };
  }

  async function cancelAndWait(
    manager: ExecutionJobManager,
    jobId: string
  ): Promise<void> {
    await manager.cancelExecution(jobId);
    for (let i = 0; i < 20; i++) {
      const status = await manager.getExecutionStatus(jobId);
      if (status.status === "cancelled") return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it("allows active jobs in different workspaces", async () => {
    const manager = new ExecutionJobManager(rootDirectory);
    const first = await manager.startExecution(startOptions(workspaceA));
    const second = await manager.startExecution(startOptions(workspaceB));

    expect(first.status).toBe("running");
    expect(second.status).toBe("running");

    await cancelAndWait(manager, first.jobId);
    await cancelAndWait(manager, second.jobId);
  });

  it("rejects a second active job in the same workspace", async () => {
    const manager = new ExecutionJobManager(rootDirectory);
    const first = await manager.startExecution(startOptions(workspaceA));

    await expect(
      manager.startExecution(startOptions(workspaceA))
    ).rejects.toThrow("workspace");

    await cancelAndWait(manager, first.jobId);
  });

  it("rejects unconfirmed cancellation for claude_write_only jobs", async () => {
    const manager = new ExecutionJobManager(rootDirectory);
    const started = await manager.startExecution({
      ...startOptions(workspaceA),
      executionMode: "claude_write_only",
      env: { FAKE_CLAUDE_MODE: "timeout" },
    });

    await expect(manager.cancelExecution(started.jobId)).rejects.toThrow(
      "explicit user request"
    );
    const active = await manager.getExecutionStatus(started.jobId);
    expect(["running", "restarting"]).toContain(active.status);

    await manager.cancelExecution(started.jobId, true);
  });

  it("loads status and logs from disk in a new manager instance", async () => {
    const firstManager = new ExecutionJobManager(rootDirectory);
    const started = await firstManager.startExecution(startOptions(workspaceA));

    const secondManager = new ExecutionJobManager(rootDirectory);
    let logs = await secondManager.getExecutionLogs(
      started.jobId,
      "stderr",
      0,
      1024
    );
    for (let i = 0; i < 100 && !logs.text; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      logs = await secondManager.getExecutionLogs(
        started.jobId,
        "stderr",
        0,
        1024
      );
    }
    const status = await secondManager.getExecutionStatus(started.jobId);

    expect(["running", "completed"]).toContain(status.status);
    expect(logs.text).toContain("starting execution");

    await cancelAndWait(firstManager, started.jobId);
  });

  it("recovers a job after its persistent worker exits", async () => {
    const manager = new ExecutionJobManager(rootDirectory);
    const started = await manager.startExecution({
      ...startOptions(workspaceA),
      env: { FAKE_CLAUDE_MODE: "timeout" },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = await manager.getExecutionStatus(started.jobId);
    expect(before.workerPid).toBeTruthy();
    expect(before.currentPid).toBeTruthy();

    process.kill(before.workerPid!, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const recovered = await manager.getExecutionStatus(started.jobId);

    expect(recovered.recoveryCount).toBe(1);
    expect(recovered.workerPid).not.toBe(before.workerPid);
    expect(["running", "restarting"]).toContain(recovered.status);
    expect(isPidAlive(before.currentPid)).toBe(false);

    await cancelAndWait(manager, started.jobId);
  });

  it("recovers a dead worker while a new manager initializes", async () => {
    const firstManager = new ExecutionJobManager(rootDirectory);
    const started = await firstManager.startExecution({
      ...startOptions(workspaceA),
      env: { FAKE_CLAUDE_MODE: "timeout" },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = await firstManager.getExecutionStatus(started.jobId);
    process.kill(before.workerPid!, "SIGKILL");
    for (let i = 0; i < 20 && isPidAlive(before.workerPid); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const secondManager = new ExecutionJobManager(rootDirectory);
    const recovered = await secondManager.getExecutionStatus(started.jobId);

    expect(recovered.recoveryCount).toBe(1);
    expect(recovered.workerPid).not.toBe(before.workerPid);
    await cancelAndWait(secondManager, started.jobId);
  });

  it("starts only one replacement worker during concurrent recovery", async () => {
    const firstManager = new ExecutionJobManager(rootDirectory);
    const started = await firstManager.startExecution({
      ...startOptions(workspaceA),
      env: { FAKE_CLAUDE_MODE: "timeout" },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = await firstManager.getExecutionStatus(started.jobId);
    const secondManager = new ExecutionJobManager(rootDirectory);
    const thirdManager = new ExecutionJobManager(rootDirectory);
    await Promise.all([
      secondManager.getExecutionStatus(started.jobId),
      thirdManager.getExecutionStatus(started.jobId),
    ]);
    process.kill(before.workerPid!, "SIGKILL");
    for (let i = 0; i < 20 && isPidAlive(before.workerPid); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const [secondStatus, thirdStatus] = await Promise.all([
      secondManager.getExecutionStatus(started.jobId),
      thirdManager.getExecutionStatus(started.jobId),
    ]);

    expect(secondStatus.workerPid).toBe(thirdStatus.workerPid);
    expect(secondStatus.recoveryCount).toBe(1);
    expect(thirdStatus.recoveryCount).toBe(1);
    await cancelAndWait(secondManager, started.jobId);
  });

  it("retries stalled Claude attempts and eventually completes", async () => {
    const attemptFile = path.join(rootDirectory, "attempts.txt");
    const previousStallMs = process.env.CLAUDE_EXECUTOR_STALL_MS;
    process.env.CLAUDE_EXECUTOR_STALL_MS = "2000";
    try {
      const manager = new ExecutionJobManager(rootDirectory);
      const started = await manager.startExecution({
        ...startOptions(workspaceA),
        env: {
          FAKE_CLAUDE_MODE: "stall-then-success",
          FAKE_CLAUDE_ATTEMPT_FILE: attemptFile,
        },
      });
      const result = await manager.waitForResult(started.jobId);
      const status = await manager.getExecutionStatus(started.jobId);

      expect(result.status).toBe("completed");
      expect(status.attempt).toBe(3);
      expect(await fs.readFile(attemptFile, "utf-8")).toBe("3");
    } finally {
      if (previousStallMs === undefined) {
        delete process.env.CLAUDE_EXECUTOR_STALL_MS;
      } else {
        process.env.CLAUDE_EXECUTOR_STALL_MS = previousStallMs;
      }
    }
  });

  it("fails with a precise stalled error after all attempts make no progress", async () => {
    const previousStallMs = process.env.CLAUDE_EXECUTOR_STALL_MS;
    process.env.CLAUDE_EXECUTOR_STALL_MS = "100";
    try {
      const manager = new ExecutionJobManager(rootDirectory);
      const started = await manager.startExecution({
        ...startOptions(workspaceA),
        env: { FAKE_CLAUDE_MODE: "timeout" },
      });
      const result = await manager.waitForResult(started.jobId);
      const status = await manager.getExecutionStatus(started.jobId);

      expect(result.status).toBe("failed");
      expect(result.error).toContain("across 3 attempts");
      expect(result.error).toContain("Last progress:");
      expect(result.error).toContain("stdout.log");
      expect(result.error).toContain("stderr.log");
      expect(status.failureKind).toBe("stalled");
      expect(status.attempt).toBe(3);
    } finally {
      if (previousStallMs === undefined) {
        delete process.env.CLAUDE_EXECUTOR_STALL_MS;
      } else {
        process.env.CLAUDE_EXECUTOR_STALL_MS = previousStallMs;
      }
    }
  });

  it("persists a terminal result when the workspace disappears", async () => {
    const manager = new ExecutionJobManager(rootDirectory);
    const started = await manager.startExecution({
      ...startOptions(workspaceA),
      env: { FAKE_CLAUDE_MODE: "delete-workspace" },
    });
    const result = await manager.waitForResult(started.jobId);
    const status = await manager.getExecutionStatus(started.jobId);

    expect(result.status).toBe("completed");
    expect(status.status).toBe("completed");
    expect(status.workspaceAfter).toMatchObject({
      kind: "non_git",
    });
    if (status.workspaceAfter?.kind === "non_git") {
      expect(status.workspaceAfter.note).toContain(
        "Workspace snapshot unavailable"
      );
    }
  });

  it("caps disk logs and reports truncation", async () => {
    const previousLimit = process.env.CLAUDE_EXECUTOR_LOG_LIMIT_BYTES;
    process.env.CLAUDE_EXECUTOR_LOG_LIMIT_BYTES = "1024";
    try {
      const manager = new ExecutionJobManager(rootDirectory);
      const started = await manager.startExecution({
        ...startOptions(workspaceA),
        env: { FAKE_CLAUDE_MODE: "large-output" },
      });
      await manager.waitForResult(started.jobId);
      const status = await manager.getExecutionStatus(started.jobId);
      const logs = await manager.getExecutionLogs(
        started.jobId,
        "stdout",
        0,
        4096
      );

      expect(status.logsTruncated.stdout).toBe(true);
      expect(Buffer.byteLength(logs.text)).toBeLessThanOrEqual(1024);
    } finally {
      if (previousLimit === undefined) {
        delete process.env.CLAUDE_EXECUTOR_LOG_LIMIT_BYTES;
      } else {
        process.env.CLAUDE_EXECUTOR_LOG_LIMIT_BYTES = previousLimit;
      }
    }
  });

  it("cleans terminal jobs older than seven days during initialization", async () => {
    const manager = new ExecutionJobManager(rootDirectory);
    const started = await manager.startExecution({
      ...startOptions(workspaceA),
      env: { FAKE_CLAUDE_MODE: "success" },
    });
    await manager.waitForResult(started.jobId);
    const status = await manager.getExecutionStatus(started.jobId);
    status.finishedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await writeStatus(rootDirectory, started.jobId, status);

    const reloaded = new ExecutionJobManager(rootDirectory);
    await expect(reloaded.getExecutionStatus(started.jobId)).rejects.toThrow(
      "Unknown job"
    );
    await expect(
      fs.access(jobDirectory(rootDirectory, started.jobId))
    ).rejects.toThrow();
  });

  it("does not remove a newer active workspace lock while cleaning an old job", async () => {
    const manager = new ExecutionJobManager(rootDirectory);
    const oldJob = await manager.startExecution({
      ...startOptions(workspaceA),
      env: { FAKE_CLAUDE_MODE: "success" },
    });
    await manager.waitForResult(oldJob.jobId);
    const oldStatus = await manager.getExecutionStatus(oldJob.jobId);
    oldStatus.finishedAt = new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000
    ).toISOString();
    await writeStatus(rootDirectory, oldJob.jobId, oldStatus);

    const activeJob = await manager.startExecution({
      ...startOptions(workspaceA),
      env: { FAKE_CLAUDE_MODE: "timeout" },
    });
    const reloaded = new ExecutionJobManager(rootDirectory);

    await expect(
      reloaded.startExecution(startOptions(workspaceA))
    ).rejects.toThrow("workspace");
    await cancelAndWait(reloaded, activeJob.jobId);
  });

  it("recovers a completed result written before its terminal status", async () => {
    const manager = new ExecutionJobManager(rootDirectory);
    const started = await manager.startExecution({
      ...startOptions(workspaceA),
      env: { FAKE_CLAUDE_MODE: "success" },
    });
    const result = await manager.waitForResult(started.jobId);
    const interruptedStatus = await manager.getExecutionStatus(started.jobId);
    interruptedStatus.status = "running";
    interruptedStatus.finishedAt = null;
    interruptedStatus.result = null;
    interruptedStatus.workerPid = null;
    interruptedStatus.currentPid = null;
    interruptedStatus.attempt = interruptedStatus.maxAttempts;
    await writeResult(rootDirectory, started.jobId, result);
    await writeStatus(rootDirectory, started.jobId, interruptedStatus);

    const reloaded = new ExecutionJobManager(rootDirectory);
    const recovered = await reloaded.getExecutionStatus(started.jobId);

    expect(recovered.status).toBe("completed");
    expect(recovered.result?.status).toBe("completed");
  });
});
