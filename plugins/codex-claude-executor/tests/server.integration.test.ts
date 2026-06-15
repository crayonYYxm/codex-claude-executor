import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const FAKE_CLAUDE_SOURCE = path.join(__dirname, "fixtures", "fake-claude.mjs");
const MCP_SERVER = path.join(PROJECT_ROOT, "dist", "mcp-server.mjs");
const FAKE_CLAUDE_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "server-integration-fixture-")
);
const FAKE_CLAUDE = path.join(FAKE_CLAUDE_ROOT, "fake-claude.mjs");
const SHARED_JOB_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "server-integration-shared-")
);
fs.copyFileSync(FAKE_CLAUDE_SOURCE, FAKE_CLAUDE);
fs.chmodSync(FAKE_CLAUDE, 0o755);

afterAll(() => {
  fs.rmSync(FAKE_CLAUDE_ROOT, { recursive: true, force: true });
});

async function createClient(
  mode: string,
  extraEnv: Record<string, string> = {}
) {
  const jobRoot =
    extraEnv.CLAUDE_EXECUTOR_JOB_ROOT ??
    fs.mkdtempSync(path.join(os.tmpdir(), `server-integration-${mode}-`));
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_SERVER],
    env: {
      ...process.env,
      CLAUDE_BIN: FAKE_CLAUDE,
      FAKE_CLAUDE_MODE: mode,
      CLAUDE_EXECUTOR_JOB_ROOT: jobRoot,
      CLAUDE_EXECUTOR_MIN_POLL_INTERVAL_MS: "0",
      CLAUDE_EXECUTOR_MIN_LOG_POLL_INTERVAL_MS: "0",
      ...extraEnv,
    },
  });

  const client = new Client({
    name: `test-client-${mode}`,
    version: "1.0.0",
  });

  await client.connect(transport);
  return { client, transport };
}

describe("MCP Server Integration", () => {
  let transport: StdioClientTransport;
  let client: Client;

  beforeAll(async () => {
    // Create transport that starts the MCP server
    transport = new StdioClientTransport({
      command: "node",
      args: [MCP_SERVER],
      env: {
        ...process.env,
        CLAUDE_BIN: FAKE_CLAUDE,
        FAKE_CLAUDE_MODE: "success",
        CLAUDE_EXECUTOR_JOB_ROOT: SHARED_JOB_ROOT,
        CLAUDE_EXECUTOR_MIN_POLL_INTERVAL_MS: "0",
        CLAUDE_EXECUTOR_MIN_LOG_POLL_INTERVAL_MS: "0",
      },
    });

    // Create client and connect
    client = new Client({
      name: "test-client",
      version: "1.0.0",
    });

    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    await client?.close();
    fs.rmSync(SHARED_JOB_ROOT, { recursive: true, force: true });
  });

  it("lists sync and async execution tools", async () => {
    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name).sort();
    expect(toolNames).toEqual([
      "cancel_execution",
      "check_environment",
      "execute_plan",
      "get_execution_logs",
      "get_execution_status",
      "start_execution",
    ]);
  });

  it("check_environment returns ready with fake successful auth", async () => {
    const result = await client.callTool({
      name: "check_environment",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");

    const data = JSON.parse(content[0].text);
    expect(data.ready).toBe(true);
    expect(data.nodeVersion).toBeTruthy();
    expect(data.claudeBin).toBe(FAKE_CLAUDE);
    expect(data.authenticated).toBe(true);
    expect(data.authMethod).toBe("api-key");
  });

  it("execute_plan returns structured successful output", async () => {
    const result = await client.callTool({
      name: "execute_plan",
      arguments: {
        workingDirectory: "/tmp",
        plan: "Test plan for integration test",
      },
    });

    expect(result.isError).toBeFalsy();

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");

    const data = JSON.parse(content[0].text);
    expect(data.status).toBe("completed");
    expect(data.workingDirectory).toBeTruthy();
    expect(data.allowedTools).toBeInstanceOf(Array);
    expect(data.allowedTools).toContain("Bash");
    expect(data.workspaceBefore).toBeTruthy();
    expect(data.workspaceAfter).toBeTruthy();
  });

  it("execute_plan accepts claude_write_only mode and records it in the result", async () => {
    const result = await client.callTool({
      name: "execute_plan",
      arguments: {
        workingDirectory: "/tmp",
        plan: "Test plan for write-only mode",
        executionMode: "claude_write_only",
      },
    });

    expect(result.isError).toBeFalsy();

    const content = result.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text);
    expect(data.executionMode).toBe("claude_write_only");
    expect(data.parsedOutput.prompt).toContain(
      "Codex is acting as planner and reviewer only."
    );
  });

  it("rejects invalid tool inputs", async () => {
    const result = await client.callTool({
      name: "execute_plan",
      arguments: {
        // Missing required workingDirectory
        plan: "Test plan",
      },
    });

    expect(result.isError).toBe(true);
  });

  it("rejects invalid extra tool rules instead of silently discarding them", async () => {
    const result = await client.callTool({
      name: "execute_plan",
      arguments: {
        workingDirectory: "/tmp",
        plan: "Test plan",
        extraAllowedTools: ["Bash(valid)\nBash(unconfirmed)"],
      },
    });

    expect(result.isError).toBe(true);
  });

  it("accepts zero timeout to disable the Claude subprocess deadline", async () => {
    const { client } = await createClient("slow-success");
    try {
      const result = await client.callTool({
        name: "start_execution",
        arguments: {
          workingDirectory: "/tmp",
          plan: "Run without a hard timeout",
          timeoutSeconds: 0,
        },
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text
      );
      expect(data.status).toBe("running");
      expect(data.timeoutSeconds).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("handles rapid sequential execute_plan calls", async () => {
    // Test that sequential calls work correctly (lock is released between calls)
    const result1 = await client.callTool({
      name: "execute_plan",
      arguments: {
        workingDirectory: "/tmp",
        plan: "First plan",
      },
    });

    expect(result1.isError).toBeFalsy();

    const result2 = await client.callTool({
      name: "execute_plan",
      arguments: {
        workingDirectory: "/tmp",
        plan: "Second plan",
      },
    });

    expect(result2.isError).toBeFalsy();
  });
});

describe("MCP Server async execution lifecycle", () => {
  it("recovers a detached job after the MCP server restarts", async () => {
    const jobRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "server-integration-restart-")
    );
    const first = await createClient("timeout", {
      CLAUDE_EXECUTOR_JOB_ROOT: jobRoot,
    });
    let jobId = "";
    try {
      const startResult = await first.client.callTool({
        name: "start_execution",
        arguments: {
          workingDirectory: "/tmp",
          plan: "Persistent job",
        },
      });
      const startData = JSON.parse(
        (startResult.content as Array<{ type: string; text: string }>)[0].text
      );
      jobId = startData.jobId;
      await first.client.close();

      const second = await createClient("timeout", {
        CLAUDE_EXECUTOR_JOB_ROOT: jobRoot,
      });
      try {
        const statusResult = await second.client.callTool({
          name: "get_execution_status",
          arguments: { jobId },
        });
        const statusData = JSON.parse(
          (statusResult.content as Array<{ type: string; text: string }>)[0].text
        );
        expect(["running", "restarting"]).toContain(statusData.status);
        expect(statusData.workerPid).toBeTruthy();
        expect(statusData.lastActivityAt).toBeTruthy();

        await second.client.callTool({
          name: "cancel_execution",
          arguments: { jobId },
        });
      } finally {
        await second.client.close();
      }
    } finally {
      if (jobId) {
        const statusPath = path.join(jobRoot, jobId, "status.json");
        const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
        if (status.workerPid) {
          try {
            process.kill(status.workerPid, "SIGKILL");
          } catch {}
        }
      }
      fs.rmSync(jobRoot, { recursive: true, force: true });
    }
  });

  it("exposes the latest readable Claude progress in job status", async () => {
    const { client } = await createClient("stream-progress");
    try {
      const startResult = await client.callTool({
        name: "start_execution",
        arguments: {
          workingDirectory: "/tmp",
          plan: "Progress plan",
        },
      });
      const startData = JSON.parse(
        (startResult.content as Array<{ type: string; text: string }>)[0].text
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
      const statusResult = await client.callTool({
        name: "get_execution_status",
        arguments: { jobId: startData.jobId },
      });
      const statusData = JSON.parse(
        (statusResult.content as Array<{ type: string; text: string }>)[0].text
      );

      expect(statusData.progress).toBeTruthy();
      expect(statusData.progress.eventCount).toBeGreaterThan(0);
      expect(statusData.progress.message).toMatch(
        /Claude attempt|Claude started|Using Write|Completed Write/
      );
      expect(statusData.progress.updatedAt).toBeTruthy();

      for (let i = 0; i < 10; i++) {
        const pollResult = await client.callTool({
          name: "get_execution_status",
          arguments: { jobId: startData.jobId },
        });
        const finalData = JSON.parse(
          (pollResult.content as Array<{ type: string; text: string }>)[0].text
        );
        if (finalData.status !== "running") {
          expect(finalData.status).toBe("completed");
          expect(finalData.progress.message).toBe("Claude finished");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      throw new Error("Progress job did not complete");
    } finally {
      await client.close();
    }
  });

  it("returns a running job before a long execute_plan call reaches the client timeout", async () => {
    const { client } = await createClient("slow-success", {
      CLAUDE_EXECUTOR_SYNC_WAIT_MS: "50",
    });
    try {
      const startedAt = Date.now();
      const executeResult = await client.callTool({
        name: "execute_plan",
        arguments: {
          workingDirectory: "/tmp",
          plan: "Plan that exceeds the synchronous wait budget",
        },
      });
      const elapsedMs = Date.now() - startedAt;
      const executeData = JSON.parse(
        (executeResult.content as Array<{ type: string; text: string }>)[0].text
      );

      expect(executeResult.isError).toBeFalsy();
      expect(executeData.status).toBe("running");
      expect(executeData.jobId).toBeTruthy();
      expect(elapsedMs).toBeLessThan(300);

      let finalData = executeData;
      for (let i = 0; i < 10 && finalData.status === "running"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const pollResult = await client.callTool({
          name: "get_execution_status",
          arguments: { jobId: executeData.jobId },
        });
        finalData = JSON.parse(
          (pollResult.content as Array<{ type: string; text: string }>)[0].text
        );
      }

      expect(finalData.status).toBe("completed");
      expect(finalData.result.status).toBe("completed");
    } finally {
      await client.close();
    }
  });

  it("starts a job, exposes status, and completes with a stored result", async () => {
    const { client } = await createClient("slow-success");
    try {
      const startResult = await client.callTool({
        name: "start_execution",
        arguments: {
          workingDirectory: "/tmp",
          plan: "Async plan",
          executionMode: "claude_write_only",
        },
      });

      expect(startResult.isError).toBeFalsy();
      const startData = JSON.parse(
        (startResult.content as Array<{ type: string; text: string }>)[0].text
      );
      expect(startData.status).toBe("running");
      expect(startData.jobId).toBeTruthy();

      const runningStatus = await client.callTool({
        name: "get_execution_status",
        arguments: { jobId: startData.jobId },
      });
      const runningData = JSON.parse(
        (runningStatus.content as Array<{ type: string; text: string }>)[0].text
      );
      expect(["running", "completed"]).toContain(runningData.status);

      let finalData = runningData;
      for (let i = 0; i < 10 && finalData.status === "running"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const pollResult = await client.callTool({
          name: "get_execution_status",
          arguments: { jobId: startData.jobId },
        });
        finalData = JSON.parse(
          (pollResult.content as Array<{ type: string; text: string }>)[0].text
        );
      }

      expect(finalData.status).toBe("completed");
      expect(finalData.executionMode).toBe("claude_write_only");
      expect(finalData.result.status).toBe("completed");
      expect(finalData.result.executionMode).toBe("claude_write_only");
      expect(finalData.result.parsedOutput.structured_output.status).toBe(
        "success"
      );
    } finally {
      await client.close();
    }
  });

  it("returns incremental stderr logs for a running job", async () => {
    const { client } = await createClient("slow-success");
    try {
      const startResult = await client.callTool({
        name: "start_execution",
        arguments: {
          workingDirectory: "/tmp",
          plan: "Async plan",
        },
      });
      const startData = JSON.parse(
        (startResult.content as Array<{ type: string; text: string }>)[0].text
      );

      await new Promise((resolve) => setTimeout(resolve, 120));

      const logsResult = await client.callTool({
        name: "get_execution_logs",
        arguments: {
          jobId: startData.jobId,
          stream: "stderr",
          offset: 0,
        },
      });
      const logsData = JSON.parse(
        (logsResult.content as Array<{ type: string; text: string }>)[0].text
      );
      expect(logsData.text).toContain("starting execution");
      expect(logsData.nextOffset).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("cancels a running job and reports cancelled status", async () => {
    const { client } = await createClient("slow-success");
    try {
      const startResult = await client.callTool({
        name: "start_execution",
        arguments: {
          workingDirectory: "/tmp",
          plan: "Async plan",
        },
      });
      const startData = JSON.parse(
        (startResult.content as Array<{ type: string; text: string }>)[0].text
      );

      const cancelResult = await client.callTool({
        name: "cancel_execution",
        arguments: { jobId: startData.jobId },
      });
      expect(cancelResult.isError).toBeFalsy();

      let finalData: any = null;
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const pollResult = await client.callTool({
          name: "get_execution_status",
          arguments: { jobId: startData.jobId },
        });
        finalData = JSON.parse(
          (pollResult.content as Array<{ type: string; text: string }>)[0].text
        );
        if (finalData.status !== "running" && finalData.status !== "cancelling") {
          break;
        }
      }

      expect(finalData.status).toBe("cancelled");
      expect(finalData.result.status).toBe("cancelled");
    } finally {
      await client.close();
    }
  });

  it("requires explicit user confirmation to cancel claude_write_only jobs", async () => {
    const { client } = await createClient("timeout");
    try {
      const startResult = await client.callTool({
        name: "start_execution",
        arguments: {
          workingDirectory: "/tmp",
          plan: "Write-only plan",
          executionMode: "claude_write_only",
        },
      });
      const startData = JSON.parse(
        (startResult.content as Array<{ type: string; text: string }>)[0].text
      );

      const rejected = await client.callTool({
        name: "cancel_execution",
        arguments: { jobId: startData.jobId },
      });
      expect(rejected.isError).toBe(true);
      expect(
        (rejected.content as Array<{ type: string; text: string }>)[0].text
      ).toContain("explicit user request");

      const accepted = await client.callTool({
        name: "cancel_execution",
        arguments: { jobId: startData.jobId, userRequested: true },
      });
      expect(accepted.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it("throttles rapid status polling at the tool boundary", async () => {
    const { client } = await createClient("timeout", {
      CLAUDE_EXECUTOR_MIN_POLL_INTERVAL_MS: "75",
    });
    try {
      const startResult = await client.callTool({
        name: "start_execution",
        arguments: {
          workingDirectory: "/tmp",
          plan: "Polling throttle plan",
        },
      });
      const startData = JSON.parse(
        (startResult.content as Array<{ type: string; text: string }>)[0].text
      );

      await client.callTool({
        name: "get_execution_status",
        arguments: { jobId: startData.jobId },
      });
      const startedAt = Date.now();
      await client.callTool({
        name: "get_execution_status",
        arguments: { jobId: startData.jobId },
      });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60);

      await client.callTool({
        name: "cancel_execution",
        arguments: { jobId: startData.jobId },
      });
    } finally {
      await client.close();
    }
  });

  it("throttles rapid log polling at the tool boundary", async () => {
    const { client } = await createClient("slow-success", {
      CLAUDE_EXECUTOR_MIN_LOG_POLL_INTERVAL_MS: "75",
    });
    try {
      const startResult = await client.callTool({
        name: "start_execution",
        arguments: {
          workingDirectory: "/tmp",
          plan: "Log throttle plan",
        },
      });
      const startData = JSON.parse(
        (startResult.content as Array<{ type: string; text: string }>)[0].text
      );

      await client.callTool({
        name: "get_execution_logs",
        arguments: { jobId: startData.jobId, stream: "stderr", offset: 0, limit: 256 },
      });
      const startedAt = Date.now();
      await client.callTool({
        name: "get_execution_logs",
        arguments: { jobId: startData.jobId, stream: "stderr", offset: 0, limit: 256 },
      });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60);

      await client.callTool({
        name: "cancel_execution",
        arguments: { jobId: startData.jobId },
      });
    } finally {
      await client.close();
    }
  });
});
