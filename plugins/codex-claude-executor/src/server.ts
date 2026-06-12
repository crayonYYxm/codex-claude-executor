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
import { runClaude } from "./claude-runner.js";
import type { EnvironmentCheckResult, ExecutePlanResult } from "./types.js";

const SERVER_NAME = "claude-executor";
const SERVER_VERSION = "0.1.0";
const SERVER_INSTRUCTIONS = `Use check_environment before the first delegation. Only call execute_plan after the user has confirmed the implementation plan and every extra allowed tool. After execution, independently inspect the workspace changes and rerun relevant tests.`;

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

  // Execution lock - only one execute_plan at a time
  let executionLock = false;

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
      // Check execution lock
      if (executionLock) {
        const errorResult = {
          error: "Another execute_plan call is already running. Only one execution is allowed at a time.",
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

      // Acquire lock
      executionLock = true;

      try {
        // Validate and resolve working directory
        let resolvedDir: string;
        try {
          resolvedDir = await resolveWorkingDirectory(params.workingDirectory);
        } catch (error) {
          const errorResult = {
            error: `Invalid working directory: ${error instanceof Error ? error.message : String(error)}`,
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

        // Validate extra tools
        let validatedExtraTools: string[] = [];
        if (params.extraAllowedTools && params.extraAllowedTools.length > 0) {
          try {
            validatedExtraTools = validateExtraAllowedTools(
              params.extraAllowedTools
            );
          } catch (error) {
            const errorResult = {
              error: `Invalid extra tools: ${error instanceof Error ? error.message : String(error)}`,
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

        // Merge allowed tools
        const allowedTools = mergeAllowedTools(validatedExtraTools);

        // Capture pre-execution workspace snapshot
        const workspaceBefore = await captureWorkspaceSnapshot(resolvedDir);

        // Run Claude
        const timeoutSeconds = params.timeoutSeconds ?? 1800;
        const runResult = await runClaude({
          workingDirectory: resolvedDir,
          plan: params.plan,
          acceptanceCriteria: params.acceptanceCriteria ?? [],
          allowedTools,
          timeoutSeconds,
          workspaceBefore,
        });

        // Capture post-execution workspace snapshot
        const workspaceAfter = await captureWorkspaceSnapshot(resolvedDir);

        // Build result
        const result: ExecutePlanResult = {
          ...runResult,
          workingDirectory: resolvedDir,
          allowedTools,
          workspaceBefore,
          workspaceAfter,
        };

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
      } finally {
        // Always release the lock
        executionLock = false;
      }
    }
  );

  return server;
}
