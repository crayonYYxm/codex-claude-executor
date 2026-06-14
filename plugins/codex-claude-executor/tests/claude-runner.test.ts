import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { runClaude, startClaude } from "../src/claude-runner.js";
import type { WorkspaceSnapshot } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE_SOURCE = path.join(__dirname, "fixtures", "fake-claude.mjs");
const WORKSPACE_BEFORE: WorkspaceSnapshot = {
  kind: "git",
  repositoryRoot: "/tmp/example",
  statusShort: " M existing.txt",
  unstagedDiffStat: " existing.txt | 1 +",
  stagedDiffStat: "",
};

describe("claude-runner", () => {
  let tempDir: string;
  let fakeClaude: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
    tempDir = await fs.realpath(tempDir);
    fakeClaude = path.join(tempDir, "fake-claude.mjs");
    await fs.copyFile(FAKE_CLAUDE_SOURCE, fakeClaude);
    await fs.chmod(fakeClaude, 0o755);
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
      claudeBin: fakeClaude,
      env: { FAKE_CLAUDE_MODE: "success" },
    });

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.parsedOutput).toBeTruthy();
    expect(result.parsedOutput).toHaveProperty(
      "structured_output.status",
      "success"
    );
    expect(result.error).toBeNull();
  });

  it("requires Claude to return a structured execution status", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Test plan",
      allowedTools: ["Read", "Write"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: fakeClaude,
      env: { FAKE_CLAUDE_MODE: "success" },
    });

    expect(result.parsedOutput).toHaveProperty(
      "args",
      expect.arrayContaining(["--json-schema"])
    );
  });

  it("handles non-zero exit code", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Test plan",
      allowedTools: ["Read"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: fakeClaude,
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
      claudeBin: fakeClaude,
      env: { FAKE_CLAUDE_MODE: "invalid-json" },
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(0);
    expect(result.error).toContain("Invalid JSON");
  });

  it("rejects ordinary JSON even when Claude exits with code zero", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Test plan",
      allowedTools: ["Read"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: fakeClaude,
      env: { FAKE_CLAUDE_MODE: "auth-success" },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("final structured success result");
  });

  it("rejects a result event without structured success", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Test plan",
      allowedTools: ["Read"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: fakeClaude,
      env: { FAKE_CLAUDE_MODE: "result-without-structured-output" },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("final structured success result");
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
      claudeBin: fakeClaude,
      env: { FAKE_CLAUDE_MODE: "timeout" },
    });

    expect(result.status).toBe("timed_out");
    expect(result.durationMs).toBeGreaterThanOrEqual(1900);
  }, 10000);

  it("disables the Claude subprocess timeout when timeoutSeconds is zero", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Long plan without a hard timeout",
      allowedTools: ["Read"],
      timeoutSeconds: 0,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: fakeClaude,
      env: { FAKE_CLAUDE_MODE: "slow-success" },
    });

    expect(result.status).toBe("completed");
    expect(result.durationMs).toBeGreaterThanOrEqual(300);
  });

  it("truncates large stdout", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Test plan",
      allowedTools: ["Read"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: fakeClaude,
      env: { FAKE_CLAUDE_MODE: "large-output" },
    });

    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(2 * 1024 * 1024 + 1000);
    expect(result.status).toBe("completed");
    expect(result.parsedOutput).toHaveProperty(
      "structured_output.status",
      "success"
    );
  });

  it("passes prompt through stdin", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "My specific test plan",
      allowedTools: ["Read"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: fakeClaude,
      env: { FAKE_CLAUDE_MODE: "success" },
    });

    expect(result.status).toBe("completed");
    expect(result.parsedOutput).toHaveProperty(
      "prompt",
      expect.stringContaining(" M existing.txt")
    );
  });

  it("adds claude_write_only collaboration constraints to the prompt", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Plan that should be executed by Claude only",
      allowedTools: ["Read", "Write"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      executionMode: "claude_write_only",
      claudeBin: fakeClaude,
      env: { FAKE_CLAUDE_MODE: "success" },
    });

    expect(result.status).toBe("completed");
    expect(result.parsedOutput).toHaveProperty(
      "prompt",
      expect.stringContaining("Codex is acting as planner and reviewer only.")
    );
    expect(result.parsedOutput).toHaveProperty(
      "prompt",
      expect.stringContaining(
        "Claude must perform every code change inside this execution."
      )
    );
  });

  it("asks Claude to run code checks but delegates preview and browser verification to Codex", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Implement a change without verifying it",
      allowedTools: ["Read", "Write"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: fakeClaude,
      env: { FAKE_CLAUDE_MODE: "success" },
    });

    expect(result.status).toBe("completed");
    expect(result.parsedOutput).toHaveProperty(
      "prompt",
      expect.stringContaining(
        "Run relevant tests, builds, and linters when allowed by the tool permissions."
      )
    );
    expect(result.parsedOutput).toHaveProperty(
      "prompt",
      expect.stringContaining(
        "Do not run previews or browser verification; Codex will perform visual and browser checks."
      )
    );
    expect(result.parsedOutput).toHaveProperty(
      "prompt",
      expect.not.stringContaining("Do not run tests, builds, linters")
    );
  });

  it("tells Claude to execute non-interactively and fail clearly when blocked", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Implement without asking follow-up questions",
      allowedTools: ["Read", "Write", "Bash"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: fakeClaude,
      env: { FAKE_CLAUDE_MODE: "success" },
    });

    expect(result.status).toBe("completed");
    expect(result.parsedOutput).toHaveProperty(
      "prompt",
      expect.stringContaining("Never use AskUserQuestion")
    );
    expect(result.parsedOutput).toHaveProperty(
      "prompt",
      expect.stringContaining("Make reasonable implementation decisions")
    );
    expect(result.parsedOutput).toHaveProperty(
      "prompt",
      expect.stringContaining(
        "return status `error` and describe exactly what information is required"
      )
    );
    expect(result.parsedOutput).toHaveProperty(
      "args",
      expect.arrayContaining(["--disallowedTools", "AskUserQuestion"])
    );
  });

  it("tells Claude to keep long-running work observable and recoverable", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Run a long implementation task",
      allowedTools: ["Read", "Write", "Bash"],
      timeoutSeconds: 0,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: fakeClaude,
      env: { FAKE_CLAUDE_MODE: "success" },
    });

    expect(result.status).toBe("completed");
    expect(result.parsedOutput).toHaveProperty(
      "prompt",
      expect.stringContaining("periodic progress output")
    );
    expect(result.parsedOutput).toHaveProperty(
      "prompt",
      expect.stringContaining("recoverable checkpoints")
    );
  });

  it("applies working directory", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Test plan",
      allowedTools: ["Read"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: fakeClaude,
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
      claudeBin: fakeClaude,
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
      claudeBin: fakeClaude,
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
      claudeBin: fakeClaude,
      env: { FAKE_CLAUDE_MODE: "delayed-output" },
    });

    expect(result.status).toBe("completed");
    expect(result.parsedOutput).toHaveProperty(
      "structured_output.status",
      "success"
    );
  });

  it("allows an in-flight process to be cancelled explicitly", async () => {
    let resolveStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const execution = startClaude(
      {
        workingDirectory: tempDir,
        plan: "Long running test plan",
        allowedTools: ["Read"],
        timeoutSeconds: 30,
        workspaceBefore: WORKSPACE_BEFORE,
        claudeBin: fakeClaude,
        env: { FAKE_CLAUDE_MODE: "slow-success" },
      },
      {
        onStderr: (chunk) => {
          if (chunk.includes("starting execution")) resolveStarted();
        },
      }
    );

    await started;
    execution.cancel();

    const result = await execution.completed;
    expect(result.status).toBe("cancelled");
    expect(result.error).toContain("cancelled");
    expect(result.stderr).toContain("starting execution");
  });

  it("emits readable progress from Claude stream events", async () => {
    const progress: string[] = [];
    const execution = startClaude(
      {
        workingDirectory: tempDir,
        plan: "Write a file",
        allowedTools: ["Read", "Write"],
        timeoutSeconds: 30,
        workspaceBefore: WORKSPACE_BEFORE,
        claudeBin: fakeClaude,
        env: { FAKE_CLAUDE_MODE: "stream-progress" },
      },
      {
        onProgress: (event) => progress.push(event.message),
      }
    );

    const result = await execution.completed;

    expect(result.status).toBe("completed");
    expect(result.parsedOutput).toHaveProperty("type", "result");
    expect(progress).toContain("Claude started");
    expect(progress).toContain("Using Write: src/example.ts");
    expect(progress).toContain("Completed Write");
    expect(progress).toContain("Implementation complete.");
    expect(progress).toContain("Claude finished");
  });

  it("emits readable progress while Claude is thinking", async () => {
    const progress: string[] = [];
    const execution = startClaude(
      {
        workingDirectory: tempDir,
        plan: "Think before writing a file",
        allowedTools: ["Read", "Write"],
        timeoutSeconds: 30,
        workspaceBefore: WORKSPACE_BEFORE,
        claudeBin: fakeClaude,
        env: { FAKE_CLAUDE_MODE: "thinking-progress" },
      },
      {
        onProgress: (event) => progress.push(event.message),
      }
    );

    const result = await execution.completed;

    expect(result.status).toBe("completed");
    expect(progress).toContain("Claude thinking (128 estimated tokens)");
    expect(progress).toContain("Claude finished");
  });

  it("treats an error result as failed even when Claude exits with code zero", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Fail cleanly",
      allowedTools: ["Read"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: fakeClaude,
      env: { FAKE_CLAUDE_MODE: "result-error" },
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(0);
    expect(result.error).toContain("Claude reported an error");
  });

  it("treats Claude's structured error status as failed", async () => {
    const result = await runClaude({
      workingDirectory: tempDir,
      plan: "Fail after required checks",
      allowedTools: ["Read", "Bash(npm test)"],
      timeoutSeconds: 30,
      workspaceBefore: WORKSPACE_BEFORE,
      claudeBin: fakeClaude,
      env: { FAKE_CLAUDE_MODE: "structured-error" },
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(0);
    expect(result.error).toContain("npm test failed with 2 failing tests");
  });

  it.runIf(process.env.RUN_REAL_CLAUDE_INTEGRATION === "1")(
    "accepts structured output from the installed Claude CLI",
    async () => {
      const result = await runClaude({
        workingDirectory: tempDir,
        plan: "Do not edit files. Return a successful structured result.",
        allowedTools: ["Read"],
        timeoutSeconds: 120,
        workspaceBefore: WORKSPACE_BEFORE,
      });

      expect(result.status).toBe("completed");
      expect(result.parsedOutput).toHaveProperty(
        "structured_output.status",
        "success"
      );
    },
    150000
  );
});
