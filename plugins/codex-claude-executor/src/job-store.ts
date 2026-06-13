import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  ExecutionJobStatusResult,
  ExecutePlanInput,
  ExecutePlanResult,
  WorkspaceSnapshot,
} from "./types.js";

export const DEFAULT_JOB_ROOT = path.join(
  os.homedir(),
  ".codex",
  "claude-executor",
  "jobs"
);
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_STALL_MS = 15 * 60 * 1000;
export const DEFAULT_LOG_LIMIT_BYTES = 20 * 1024 * 1024;
export const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type PersistedJobRequest = Required<
  Pick<
    ExecutePlanInput,
    | "workingDirectory"
    | "plan"
    | "acceptanceCriteria"
    | "extraAllowedTools"
    | "executionMode"
    | "timeoutSeconds"
  >
> & {
  allowedTools: string[];
  workspaceBefore: WorkspaceSnapshot;
  claudeBin?: string;
  env?: Record<string, string>;
  stallMs: number;
  maxAttempts: number;
  logLimitBytes: number;
};

export function jobDirectory(root: string, jobId: string): string {
  return path.join(root, jobId);
}

export function jobPath(root: string, jobId: string, name: string): string {
  return path.join(jobDirectory(root, jobId), name);
}

export async function ensureJobRoot(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(root, ".locks"), { recursive: true });
}

export async function atomicWriteJson(
  filePath: string,
  value: unknown
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf-8");
  await fs.rename(temporaryPath, filePath);
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
}

export async function readStatus(
  root: string,
  jobId: string
): Promise<ExecutionJobStatusResult> {
  return readJson<ExecutionJobStatusResult>(jobPath(root, jobId, "status.json"));
}

export async function writeStatus(
  root: string,
  jobId: string,
  status: ExecutionJobStatusResult
): Promise<void> {
  await atomicWriteJson(jobPath(root, jobId, "status.json"), status);
}

export async function readRequest(
  root: string,
  jobId: string
): Promise<PersistedJobRequest> {
  return readJson<PersistedJobRequest>(jobPath(root, jobId, "request.json"));
}

export async function writeResult(
  root: string,
  jobId: string,
  result: ExecutePlanResult
): Promise<void> {
  await atomicWriteJson(jobPath(root, jobId, "result.json"), result);
}

export async function readResult(
  root: string,
  jobId: string
): Promise<ExecutePlanResult> {
  return readJson<ExecutePlanResult>(jobPath(root, jobId, "result.json"));
}

export function isTerminalStatus(status: string): boolean {
  return [
    "completed",
    "failed",
    "timed_out",
    "cancelled",
    "environment_error",
  ].includes(status);
}

export function isPidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function workspaceLockPath(root: string, workingDirectory: string): string {
  const hash = createHash("sha256").update(workingDirectory).digest("hex");
  return path.join(root, ".locks", `${hash}.lock`);
}

export async function removeWorkspaceLock(
  root: string,
  workingDirectory: string,
  expectedJobId?: string
): Promise<void> {
  const lockPath = workspaceLockPath(root, workingDirectory);
  if (expectedJobId) {
    try {
      const currentJobId = (await fs.readFile(lockPath, "utf-8")).trim();
      if (currentJobId !== expectedJobId) return;
    } catch {
      return;
    }
  }
  await fs.rm(lockPath, { force: true });
}

export async function safeWorkspaceSnapshot(
  workingDirectory: string,
  capture: (directory: string) => Promise<WorkspaceSnapshot>
): Promise<WorkspaceSnapshot> {
  try {
    return await capture(workingDirectory);
  } catch (error) {
    return {
      kind: "non_git",
      note: `Workspace snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function appendCappedLog(
  filePath: string,
  chunk: string,
  limitBytes: number
): Promise<boolean> {
  const chunkBuffer = Buffer.from(chunk);
  await fs.appendFile(filePath, chunkBuffer);
  const stat = await fs.stat(filePath);
  if (stat.size <= limitBytes) return false;

  // Truncate in larger batches so sustained output does not repeatedly read
  // and rewrite the entire maximum-sized log for every small chunk.
  const retainedBytes = Math.max(
    Math.floor(limitBytes / 2),
    Math.min(limitBytes, chunkBuffer.length)
  );
  const handle = await fs.open(filePath, "r");
  const retained = Buffer.alloc(retainedBytes);
  try {
    await handle.read(retained, 0, retainedBytes, stat.size - retainedBytes);
  } finally {
    await handle.close();
  }
  await fs.writeFile(filePath, retained);
  return true;
}

export async function cleanupOldJobs(root: string, now = Date.now()): Promise<void> {
  await ensureJobRoot(root);
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".locks") continue;
    try {
      const status = await readStatus(root, entry.name);
      if (
        isTerminalStatus(status.status) &&
        status.finishedAt &&
        now - Date.parse(status.finishedAt) > TERMINAL_RETENTION_MS
      ) {
        await removeWorkspaceLock(root, status.workingDirectory, entry.name);
        await fs.rm(jobDirectory(root, entry.name), { recursive: true, force: true });
      }
    } catch {
      // Ignore malformed entries; they remain available for manual diagnosis.
    }
  }
}
