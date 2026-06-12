import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const FAKE_CLAUDE = path.join(__dirname, "fixtures", "fake-claude.mjs");
const MCP_SERVER = path.join(PROJECT_ROOT, "dist", "mcp-server.mjs");

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
  });

  it("lists exactly two tools", async () => {
    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name).sort();
    expect(toolNames).toEqual(["check_environment", "execute_plan"]);
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
    expect(data.workspaceBefore).toBeTruthy();
    expect(data.workspaceAfter).toBeTruthy();
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
