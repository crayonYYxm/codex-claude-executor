/**
 * MCP Server composition module.
 *
 * Creates and configures the McpServer with tool registrations.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as os from "node:os";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import {
  resolveWorkingDirectory,
  captureWorkspaceSnapshot,
} from "./workspace.js";
import { mergeAllowedTools, validateExtraAllowedTools } from "./permissions.js";
import {
  ExecutionJobManager,
  resolveWorkerPath,
} from "./job-manager.js";
import {
  DEFAULT_JOB_ROOT,
  jobPath,
  readRequest,
  type PersistedJobRequest,
} from "./job-store.js";
import type {
  EnvironmentCheckResult,
  ExecutionMode,
  ExecutionJobStatusResult,
  ExecutePlanInput,
  ExecutePlanResponse,
  FailureKind,
  JobStatus,
} from "./types.js";

const SERVER_NAME = "claude-executor";
const SERVER_VERSION = "0.1.0";
const DEFAULT_SYNC_WAIT_MS = 90_000;
const MAX_SYNC_WAIT_MS = 90_000;
const FIRST_STATUS_POLL_DELAY_MS = 15_000;
const DEFAULT_MIN_STATUS_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MIN_LOG_POLL_INTERVAL_MS = 60_000;
export const SERVER_INSTRUCTIONS = `Use check_environment before the first delegation. Use start_execution by default so long-running work cannot hit the MCP client's request timeout, then poll get_execution_status and relay meaningful progress. Make the first status check after roughly 15 seconds. Healthy long-running jobs should usually be checked about once per minute, medium jobs about every 2 minutes, and long tasks can be checked as slowly as about every 5 minutes while they remain healthy. Execution runs in a detached persistent worker and survives MCP or Codex restarts. There is no hard Claude deadline; after 15 minutes without activity the worker restarts Claude, for at most three attempts. Treat running, restarting, and cancelling as non-terminal states: keep polling and never report success or failure from an intermediate workspace snapshot. non-terminal Claude jobs must never be finalized to the user as if the task were done. Partial workspace diffs during these active states are not permission for Codex to intervene or patch code. In claude_write_only mode, while the job remains running, restarting, or cancelling, Codex must not modify files in that workspace, even to finish only the untouched half of a partial implementation. Treat a changing lastActivityAt or thinking progress as active work; do not cancel an active job merely because no file has appeared yet. Claude runs non-interactively: it must never ask the user questions, and missing essential information must be returned as a structured error. Long-running work must stay in the foreground and should emit periodic progress or use recoverable checkpoints so the worker can distinguish active work from a stall. Prefer event-driven monitoring over routine narration: short jobs may still emit a sparse heartbeat about every 3 minutes, medium jobs about every 4 minutes, and long jobs about every 5 minutes while they keep making progress. Read execution logs only when progress stalls, after a restart, or when terminal diagnosis is needed. Only call cancel_execution after the user explicitly asks to cancel; claude_write_only jobs enforce this at the tool boundary. Claude has fixed Read, Glob, Grep, Edit, Write, and unrestricted Bash permissions during delegated execution, so it can perform normal file CRUD and project commands without reconfirmation. Claude performs implementation plus relevant tests, builds, linters, and typechecks, but not previews or browser verification. After Claude completes, Codex must independently inspect and verify the workspace and perform any required preview or browser checks. If verification fails, delegate a focused repair plan to Claude and never directly patch code in claude_write_only mode. If Claude returns failed or environment_error, or cannot recover from interruption, stop, report exact evidence, and ask the user whether to wait, investigate, retry Claude, or explicitly authorize Codex takeover. Do not choose a takeover path without user authorization. When Codex must remain planner/reviewer only while Claude performs all edits, set executionMode to claude_write_only.`;
const EXECUTION_MODE_SCHEMA = z
  .enum(["standard", "claude_write_only"])
  .default("standard")
  .describe(
    "Execution collaboration mode. Use claude_write_only when Codex should stay in a planner/reviewer role and Claude should perform all code changes inside the delegated run."
  );

const executionJobManager = new ExecutionJobManager();

type MonitoringTier = "short" | "medium" | "long";

type MonitoringObservation = {
  lastActivityAt: string;
  lastProgressUpdatedAt: string | null;
  lastStatus: JobStatus;
  stagnantPolls: number;
};

type DiagnosticLogContext = {
  status: JobStatus;
  failureKind: FailureKind;
  stagnantPolls: number;
};

export function isExecutionResponseError(status: JobStatus): boolean {
  return !["completed", "running", "restarting", "cancelling"].includes(status);
}

export function classifyMonitoringTier(
  plan: string,
  acceptanceCriteria: string[]
): MonitoringTier {
  if (plan.length < 1500 && acceptanceCriteria.length <= 3) {
    return "short";
  }
  if (plan.length < 6000 && acceptanceCriteria.length <= 8) {
    return "medium";
  }
  return "long";
}

export function getAdaptiveStatusPollIntervalMs(
  tier: MonitoringTier
): number {
  switch (tier) {
    case "short":
      return 60_000;
    case "medium":
      return 120_000;
    case "long":
      return 300_000;
  }
}

export function getAdaptiveHeartbeatIntervalMs(
  tier: MonitoringTier
): number {
  switch (tier) {
    case "short":
      return 180_000;
    case "medium":
      return 240_000;
    case "long":
      return 300_000;
  }
}

export function shouldAllowDiagnosticLogRead(
  context: DiagnosticLogContext
): boolean {
  return (
    context.status === "restarting" ||
    context.status === "failed" ||
    context.status === "environment_error" ||
    context.stagnantPolls >= 2
  );
}

function getSyncWaitMs(): number {
  const configured = Number(process.env.CLAUDE_EXECUTOR_SYNC_WAIT_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_SYNC_WAIT_MS;
  }
  return Math.min(Math.floor(configured), MAX_SYNC_WAIT_MS);
}

function getMinStatusPollIntervalMs(): number {
  const configured = Number(process.env.CLAUDE_EXECUTOR_MIN_POLL_INTERVAL_MS);
  if (!Number.isFinite(configured)) {
    return DEFAULT_MIN_STATUS_POLL_INTERVAL_MS;
  }
  return Math.max(0, Math.floor(configured));
}

function getMinLogPollIntervalMs(): number {
  const configured = Number(
    process.env.CLAUDE_EXECUTOR_MIN_LOG_POLL_INTERVAL_MS
  );
  if (!Number.isFinite(configured)) {
    return DEFAULT_MIN_LOG_POLL_INTERVAL_MS;
  }
  return Math.max(0, Math.floor(configured));
}

function getJobRootDirectory(): string {
  return process.env.CLAUDE_EXECUTOR_JOB_ROOT ?? DEFAULT_JOB_ROOT;
}

async function throttlePoll(
  pollMap: Map<string, number>,
  key: string,
  minIntervalMs: number,
  baselineMs?: number
): Promise<void> {
  const lastPollAt = pollMap.get(key);
  const anchorMs = lastPollAt ?? baselineMs;
  if (anchorMs !== undefined) {
    const remainingMs = minIntervalMs - (Date.now() - anchorMs);
    if (remainingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, remainingMs));
    }
  }
  pollMap.set(key, Date.now());
}

function buildMonitoringObservation(
  status: ExecutionJobStatusResult,
  previous?: MonitoringObservation
): MonitoringObservation {
  const progressUpdatedAt = status.progress?.updatedAt ?? null;
  const sameActivity =
    previous?.lastActivityAt === status.lastActivityAt &&
    previous?.lastProgressUpdatedAt === progressUpdatedAt &&
    previous?.lastStatus === status.status;
  const stagnantPolls =
    status.status === "running" && sameActivity
      ? (previous?.stagnantPolls ?? 0) + 1
      : 0;

  return {
    lastActivityAt: status.lastActivityAt,
    lastProgressUpdatedAt: progressUpdatedAt,
    lastStatus: status.status,
    stagnantPolls,
  };
}

/**
 * Execute a command with timeout, returning stdout.
 */
function execCommand(
  command: string,
  args: string[],
  timeoutMs: number = 15000
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    );
  });
}

/**
 * Create and configure an MCP server instance.
 */
export function createServer(): McpServer {
  const lastStatusPollAt = new Map<string, number>();
  const lastLogPollAt = new Map<string, number>();
  const monitoringTierByJob = new Map<string, MonitoringTier>();
  const monitoringObservationByJob = new Map<string, MonitoringObservation>();
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  async function prepareExecution(params: ExecutePlanInput) {
    const resolvedDir = await resolveWorkingDirectory(params.workingDirectory);

    let validatedExtraTools: string[] = [];
    if (params.extraAllowedTools && params.extraAllowedTools.length > 0) {
      validatedExtraTools = validateExtraAllowedTools(params.extraAllowedTools);
    }

    const allowedTools = mergeAllowedTools(validatedExtraTools);
    const workspaceBefore = await captureWorkspaceSnapshot(resolvedDir);
    const executionMode: ExecutionMode = params.executionMode ?? "standard";
    const timeoutSeconds = params.timeoutSeconds ?? 0;

    return {
      resolvedDir,
      allowedTools,
      executionMode,
      timeoutSeconds,
      workspaceBefore,
    };
  }

  async function getMonitoringTier(jobId: string): Promise<MonitoringTier> {
    const cached = monitoringTierByJob.get(jobId);
    if (cached) return cached;

    const request: PersistedJobRequest = await readRequest(getJobRootDirectory(), jobId);
    const tier = classifyMonitoringTier(
      request.plan,
      request.acceptanceCriteria ?? []
    );
    monitoringTierByJob.set(jobId, tier);
    return tier;
  }

  // Register check_environment tool
  server.tool(
    "check_environment",
    "Check whether the local machine can execute Claude Code before attempting a plan.",
    {},
    async () => {
      const errors: string[] = [];
      const nodeVersion = process.version;
      const claudeBin = process.env.CLAUDE_BIN ?? "claude";
      let claudeVersion: string | null = null;
      let authenticated = false;
      let authMethod: string | null = null;

      try {
        await fs.access(resolveWorkerPath());
      } catch {
        errors.push(`Persistent worker bundle is missing: ${resolveWorkerPath()}`);
      }

      // Check Claude version
      try {
        const { stdout } = await execCommand(claudeBin, ["--version"]);
        claudeVersion = stdout.trim();
      } catch (error) {
        errors.push(
          `Failed to get Claude version: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      // Check Claude auth
      try {
        const { stdout } = await execCommand(claudeBin, [
          "auth",
          "status",
          "--json",
        ]);
        try {
          const authData = JSON.parse(stdout);
          authenticated = authData.loggedIn === true;
          authMethod = authData.authMethod ?? null;
          if (!authenticated) {
            errors.push("Claude is not authenticated");
          }
        } catch {
          errors.push("Failed to parse Claude auth status JSON");
        }
      } catch (error) {
        errors.push(
          `Failed to check Claude auth: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      const result: EnvironmentCheckResult = {
        ready: errors.length === 0,
        nodeVersion,
        claudeBin,
        claudeVersion,
        authenticated,
        authMethod,
        errors,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // Register execute_plan tool
  server.tool(
    "execute_plan",
    "Execute an already confirmed implementation plan with local Claude Code. Returns a running job when execution exceeds the synchronous wait budget.",
    {
      workingDirectory: z.string().describe("Absolute path to the working directory"),
      plan: z
        .string()
        .trim()
        .min(1)
        .max(100000)
        .describe("The implementation plan to execute"),
      acceptanceCriteria: z
        .array(z.string().trim().min(1))
        .max(50)
        .optional()
        .describe("Acceptance criteria for the plan"),
      extraAllowedTools: z
        .array(z.string().min(1).max(300))
        .max(20)
        .optional()
        .describe("Additional tool permissions for this execution"),
      executionMode: EXECUTION_MODE_SCHEMA.optional(),
      timeoutSeconds: z
        .number()
        .int()
        .min(0)
        .max(7200)
        .optional()
        .describe("Deprecated compatibility field. Persistent workers always run without a hard Claude deadline."),
    },
    {
      destructiveHint: true,
      idempotentHint: false,
    },
    async (params) => {
      try {
        const {
          resolvedDir,
          allowedTools,
          executionMode,
          timeoutSeconds,
          workspaceBefore,
        } =
          await prepareExecution(params);
        const started = await executionJobManager.startExecution({
          workingDirectory: resolvedDir,
          plan: params.plan,
          acceptanceCriteria: params.acceptanceCriteria ?? [],
          allowedTools,
          executionMode,
          timeoutSeconds,
          workspaceBefore,
        });
        monitoringTierByJob.set(
          started.jobId,
          classifyMonitoringTier(
            params.plan,
            params.acceptanceCriteria ?? []
          )
        );
        const result: ExecutePlanResponse =
          await executionJobManager.waitForResultOrStatus(
            started.jobId,
            getSyncWaitMs()
          );

        const isError = isExecutionResponseError(result.status);

        return {
          isError,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorResult = {
          error: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
        };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(errorResult),
            },
          ],
        };
      }
    }
  );

  server.tool(
    "start_execution",
    "Start an already confirmed implementation or repair plan in the background. Prefer this tool to avoid MCP client request timeouts.",
    {
      workingDirectory: z.string().describe("Absolute path to the working directory"),
      plan: z
        .string()
        .trim()
        .min(1)
        .max(100000)
        .describe("The implementation plan to execute"),
      acceptanceCriteria: z
        .array(z.string().trim().min(1))
        .max(50)
        .optional()
        .describe("Acceptance criteria for the plan"),
      extraAllowedTools: z
        .array(z.string().min(1).max(300))
        .max(20)
        .optional()
        .describe("Additional tool permissions for this execution"),
      executionMode: EXECUTION_MODE_SCHEMA.optional(),
      timeoutSeconds: z
        .number()
        .int()
        .min(0)
        .max(7200)
        .optional()
        .describe("Deprecated compatibility field. Persistent workers always run without a hard Claude deadline."),
    },
    {
      destructiveHint: true,
      idempotentHint: false,
    },
    async (params) => {
      try {
        const {
          resolvedDir,
          allowedTools,
          executionMode,
          timeoutSeconds,
          workspaceBefore,
        } =
          await prepareExecution(params);
        const result = await executionJobManager.startExecution({
          workingDirectory: resolvedDir,
          plan: params.plan,
          acceptanceCriteria: params.acceptanceCriteria ?? [],
          allowedTools,
          executionMode,
          timeoutSeconds,
          workspaceBefore,
        });
        monitoringTierByJob.set(
          result.jobId,
          classifyMonitoringTier(
            params.plan,
            params.acceptanceCriteria ?? []
          )
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  server.tool(
    "get_execution_status",
    "Get persistent job state, attempt/recovery metadata, and latest readable Claude progress. Rapid repeated polls are throttled server-side.",
    {
      jobId: z.string().uuid().describe("The job identifier returned by start_execution"),
    },
    async ({ jobId }) => {
      try {
        const previewStatus = await executionJobManager.getExecutionStatus(jobId);
        const tier = await getMonitoringTier(jobId);
        const previousObservation = monitoringObservationByJob.get(jobId);
        const previewObservation = buildMonitoringObservation(
          previewStatus,
          previousObservation
        );
        const configured = Number(process.env.CLAUDE_EXECUTOR_MIN_POLL_INTERVAL_MS);
        const minIntervalMs = Number.isFinite(configured)
          ? Math.max(0, Math.floor(configured))
          : previewStatus.status === "restarting" ||
              previewObservation.stagnantPolls >= 2
            ? 60_000
            : getAdaptiveStatusPollIntervalMs(tier);

        const hasPolledBefore = lastStatusPollAt.has(jobId);
        const firstPollIntervalMs = Number.isFinite(configured)
          ? minIntervalMs
          : FIRST_STATUS_POLL_DELAY_MS;
        await throttlePoll(
          lastStatusPollAt,
          jobId,
          hasPolledBefore ? minIntervalMs : firstPollIntervalMs,
          hasPolledBefore ? undefined : Date.parse(previewStatus.startedAt)
        );
        const result = await executionJobManager.getExecutionStatus(jobId);
        monitoringObservationByJob.set(
          jobId,
          buildMonitoringObservation(result, previousObservation)
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  server.tool(
    "get_execution_logs",
    "Read incremental stdout or stderr logs for a background Claude execution job. Rapid repeated log polls are throttled server-side.",
    {
      jobId: z.string().uuid().describe("The job identifier returned by start_execution"),
      stream: z
        .enum(["stdout", "stderr"])
        .default("stderr")
        .describe("Which log stream to read"),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Byte offset to start reading from"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(65536)
        .default(65536)
        .describe("Maximum number of log bytes to return"),
    },
    async ({ jobId, stream, offset, limit }) => {
      try {
        const status = await executionJobManager.getExecutionStatus(jobId);
        const tier = await getMonitoringTier(jobId);
        const observation =
          monitoringObservationByJob.get(jobId) ??
          buildMonitoringObservation(status);
        const configured = Number(
          process.env.CLAUDE_EXECUTOR_MIN_LOG_POLL_INTERVAL_MS
        );
        const allowDiagnostic = shouldAllowDiagnosticLogRead({
          status: status.status,
          failureKind: status.failureKind,
          stagnantPolls: observation.stagnantPolls,
        });
        const minIntervalMs = Number.isFinite(configured)
          ? Math.max(0, Math.floor(configured))
          : allowDiagnostic
            ? 0
            : getAdaptiveStatusPollIntervalMs(tier);
        await throttlePoll(
          lastLogPollAt,
          `${jobId}:${stream}`,
          minIntervalMs
        );
        let effectiveOffset = offset;
        if (allowDiagnostic && offset === 0) {
          try {
            const logStat = await fs.stat(
              jobPath(getJobRootDirectory(), jobId, `${stream}.log`)
            );
            effectiveOffset = Math.max(0, logStat.size - limit);
          } catch {
            effectiveOffset = offset;
          }
        }
        const result = await executionJobManager.getExecutionLogs(
          jobId,
          stream,
          effectiveOffset,
          limit
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  server.tool(
    "cancel_execution",
    "Cancel a running background Claude execution job only after the user explicitly asks to cancel.",
    {
      jobId: z.string().uuid().describe("The job identifier returned by start_execution"),
      userRequested: z
        .boolean()
        .default(false)
        .describe(
          "Set true only when the user explicitly requested cancellation. Required for claude_write_only jobs."
        ),
    },
    {
      destructiveHint: true,
      idempotentHint: false,
    },
    async ({ jobId, userRequested }) => {
      try {
        const result = await executionJobManager.cancelExecution(
          jobId,
          userRequested
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: error instanceof Error ? error.message : String(error),
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  return server;
}
