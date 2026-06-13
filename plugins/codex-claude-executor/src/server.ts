/**
 * MCP Server composition module.
 *
 * Creates and configures the McpServer with tool registrations.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as os from "node:os";
import { execFile } from "node:child_process";
import {
  resolveWorkingDirectory,
  captureWorkspaceSnapshot,
} from "./workspace.js";
import { mergeAllowedTools, validateExtraAllowedTools } from "./permissions.js";
import { ExecutionJobManager } from "./job-manager.js";
import type {
  EnvironmentCheckResult,
  ExecutionMode,
  ExecutePlanInput,
  ExecutePlanResult,
} from "./types.js";

const SERVER_NAME = "claude-executor";
const SERVER_VERSION = "0.1.0";
const SERVER_INSTRUCTIONS = `Use check_environment before the first delegation. For short tasks, execute_plan can run synchronously after the user has confirmed the implementation plan and every extra allowed tool. For long tasks, prefer start_execution, then poll with get_execution_status and get_execution_logs, and cancel with cancel_execution when needed. After execution, independently inspect the workspace changes and rerun relevant tests. When you want Codex to stay in a planner/reviewer role while Claude performs all code edits, set executionMode to claude_write_only.`;
const EXECUTION_MODE_SCHEMA = z
  .enum(["standard", "claude_write_only"])
  .default("standard")
  .describe(
    "Execution collaboration mode. Use claude_write_only when Codex should stay in a planner/reviewer role and Claude should perform all code changes inside the delegated run."
  );

const executionJobManager = new ExecutionJobManager();

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
    const timeoutSeconds = params.timeoutSeconds ?? 1800;

    return {
      resolvedDir,
      allowedTools,
      executionMode,
      timeoutSeconds,
      workspaceBefore,
    };
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
    "Execute an already confirmed implementation plan with local Claude Code.",
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
        .min(60)
        .max(7200)
        .optional()
        .describe("Timeout in seconds (60-7200, default 1800)"),
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
        const result: ExecutePlanResult = await executionJobManager.waitForResult(
          started.jobId
        );

        const isError = result.status !== "completed";

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
    "Start an already confirmed implementation plan in the background for long-running Claude Code work.",
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
        .min(60)
        .max(7200)
        .optional()
        .describe("Timeout in seconds (60-7200, default 1800)"),
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
    "Get the current state of a background Claude execution job.",
    {
      jobId: z.string().uuid().describe("The job identifier returned by start_execution"),
    },
    async ({ jobId }) => {
      try {
        const result = executionJobManager.getExecutionStatus(jobId);
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
    "Read incremental stdout or stderr logs for a background Claude execution job.",
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
        .describe("Character offset to start reading from"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(65536)
        .default(65536)
        .describe("Maximum number of characters to return"),
    },
    async ({ jobId, stream, offset, limit }) => {
      try {
        const result = await executionJobManager.getExecutionLogs(
          jobId,
          stream,
          offset,
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
    "Cancel a running background Claude execution job.",
    {
      jobId: z.string().uuid().describe("The job identifier returned by start_execution"),
    },
    {
      destructiveHint: true,
      idempotentHint: false,
    },
    async ({ jobId }) => {
      try {
        const result = await executionJobManager.cancelExecution(jobId);
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
