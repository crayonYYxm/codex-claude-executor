import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { runClaude, startClaude } from "../src/claude-runner.js";
import type { WorkspaceSnapshot } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(__dirname, "fixtures", "fake-claude.mjs");
const WORKSPACE_BEFORE: WorkspaceSnapshot = {
  kind: "git",
  repositoryRoot: "/tmp/example",
  statusShort: " M existing.txt",
  unstagedDiffStat: " existing.txt | 1 +",
  stagedDiffStat: "",
};

describe("claude-runner", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
    tempDir = await fs.realpath(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("executes successfully with valid JSON output", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Test plan",
      allowedTools: ["Read", "Write"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: FAKE_CLAUDE,
      env: { FAKE_CLAUDE_MODE: "success" },
    });

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.parsedOutput).toBeTruthy();
    expect(result.parsedOutput).toHaveProperty("status", "success");
    expect(result.error).toBeNull();
  });

  it("handles non-zero exit code", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Test plan",
      allowedTools: ["Read"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: FAKE_CLAUDE,
      env: { FAKE_CLAUDE_MODE: "failure" },
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeTruthy();
  });

  it("handles invalid JSON with zero exit code", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Test plan",
      allowedTools: ["Read"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: FAKE_CLAUDE,
      env: { FAKE_CLAUDE_MODE: "invalid-json" },
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(0);
    expect(result.error).toContain("Invalid JSON");
  });

  it("handles missing executable", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Test plan",
      allowedTools: ["Read"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: "/nonexistent/claude",
    });

    expect(result.status).toBe("environment_error");
    expect(result.error).toBeTruthy();
  });

  it("handles timeout and forced termination", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Test plan",
      allowedTools: ["Read"],
      timeoutSeconds: 2,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: FAKE_CLAUDE,
      env: { FAKE_CLAUDE_MODE: "timeout" },
    });

    expect(result.status).toBe("timed_out");
    expect(result.durationMs).toBeGreaterThanOrEqual(1900);
  }, 10000);

  it("truncates large stdout", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Test plan",
      allowedTools: ["Read"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: FAKE_CLAUDE,
      env: { FAKE_CLAUDE_MODE: "large-output" },
    });

    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(2 * 1024 * 1024 + 1000);
  });

  it("passes prompt through stdin", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "My specific test plan",
      allowedTools: ["Read"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: FAKE_CLAUDE,
      env: { FAKE_CLAUDE_MODE: "success" },
    });

    expect(result.status).toBe("completed");
    expect(result.parsedOutput).toHaveProperty(
      "prompt",
      expect.stringContaining(" M existing.txt")
    );
  });

  it("applies working directory", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Test plan",
      allowedTools: ["Read"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: FAKE_CLAUDE,
      env: { FAKE_CLAUDE_MODE: "success" },
    });

    expect(result.status).toBe("completed");
  });

  it("passes allowed tools without shell interpretation", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Test plan",
      allowedTools: ["Read", "Bash(git status)", "Bash(npm test *)"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: FAKE_CLAUDE,
      env: { FAKE_CLAUDE_MODE: "success" },
    });

    expect(result.status).toBe("completed");
  });

  it("kills a process that ignores SIGTERM before returning timed_out", async () => {
    const pidFile = path.join(tempDir, "fake-claude.pid");
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Test plan",
      allowedTools: ["Read"],
      timeoutSeconds: 1,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: FAKE_CLAUDE,
      env: {
        FAKE_CLAUDE_MODE: "ignore-sigterm",
        FAKE_CLAUDE_PID_FILE: pidFile,
      },
    });

    const pid = Number(await fs.readFile(pidFile, "utf-8"));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) {
      process.kill(pid, "SIGKILL");
    }

    expect(result.status).toBe("timed_out");
    expect(alive).toBe(false);
  }, 10000);

  it("waits for stdout to close before parsing JSON", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Test plan",
      allowedTools: ["Read"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: FAKE_CLAUDE,
      env: { FAKE_CLAUDE_MODE: "delayed-output" },
    });

    expect(result.status).toBe("completed");
    expect(result.parsedOutput).toHaveProperty("status", "success");
  });

  it("allows an in-flight process to be cancelled explicitly", async () => {
    const execution = startClaude({
      workingDirectory: tempDir,
      plan: "Long running test plan",
      allowedTools: ["Read"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: FAKE_CLAUDE,
      env: { FAKE_CLAUDE_MODE: "slow-success" },
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    execution.cancel();

    const result = await execution.completed;
    expect(result.status).toBe("cancelled");
    expect(result.error).toContain("cancelled");
    expect(result.stderr).toContain("starting execution");
  });
});
