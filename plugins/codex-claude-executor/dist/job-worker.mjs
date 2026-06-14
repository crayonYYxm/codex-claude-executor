// src/job-worker.ts
import * as fs3 from "node:fs/promises";

// src/claude-runner.ts
import { spawn } from "node:child_process";
var MAX_OUTPUT_SIZE = 2 * 1024 * 1024;
var SIGTERM_WAIT_MS = 5e3;
var RESULT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    status: { type: "string", enum: ["success", "error"] },
    summary: { type: "string" },
    error: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
    commandsExecuted: { type: "array", items: { type: "string" } },
    checks: { type: "array", items: { type: "string" } }
  },
  required: ["status", "summary"],
  additionalProperties: false
});
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
function parseClaudeOutput(stdout) {
  const wholeOutput = parseJsonLine(stdout);
  if (wholeOutput !== null) {
    return wholeOutput;
  }
  const lines = stdout.trim().split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index--) {
    const parsed = parseJsonLine(lines[index]);
    if (isRecord(parsed) && parsed.type === "result") {
      return parsed;
    }
  }
  return null;
}
function isClaudeErrorResult(value) {
  const structuredOutput = isRecord(value) ? value.structured_output : null;
  return isRecord(value) && (value.type === "result" && (value.is_error === true || value.subtype === "error") || isRecord(structuredOutput) && structuredOutput.status === "error");
}
function isClaudeSuccessResult(value) {
  return isRecord(value) && value.type === "result" && value.is_error !== true && isRecord(value.structured_output) && value.structured_output.status === "success";
}
function getClaudeErrorMessage(value) {
  if (isRecord(value) && isRecord(value.structured_output)) {
    const structuredOutput = value.structured_output;
    if (typeof structuredOutput.error === "string") {
      return `Claude reported an error: ${structuredOutput.error}`;
    }
    if (typeof structuredOutput.summary === "string") {
      return `Claude reported an error: ${structuredOutput.summary}`;
    }
  }
  if (isRecord(value) && typeof value.result === "string") {
    return `Claude reported an error: ${value.result}`;
  }
  return "Claude reported an error";
}
function summarizeToolInput(input) {
  if (!isRecord(input)) return null;
  const keys = ["description", "file_path", "path", "command", "pattern", "query"];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().replace(/\s+/g, " ").slice(0, 180);
    }
  }
  return null;
}
function getContentBlocks(event) {
  const message = event.message;
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return [];
  }
  return message.content;
}
function emitProgressFromEvent(event, toolNames, onProgress) {
  if (!onProgress || !isRecord(event)) return;
  if (event.type === "system" && event.subtype === "init") {
    onProgress({ message: "Claude started" });
    return;
  }
  if (event.type === "system" && event.subtype === "thinking_tokens" && typeof event.estimated_tokens === "number") {
    onProgress({
      message: `Claude thinking (${event.estimated_tokens} estimated tokens)`
    });
    return;
  }
  if (event.type === "result") {
    onProgress({
      message: isClaudeErrorResult(event) ? "Claude reported an error" : "Claude finished"
    });
    return;
  }
  for (const block of getContentBlocks(event)) {
    if (!isRecord(block)) continue;
    if (event.type === "assistant" && block.type === "tool_use" && typeof block.name === "string") {
      if (typeof block.id === "string") {
        toolNames.set(block.id, block.name);
      }
      const detail = summarizeToolInput(block.input);
      onProgress({
        message: `Using ${block.name}${detail ? `: ${detail}` : ""}`
      });
    } else if (event.type === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const toolName = toolNames.get(block.tool_use_id) ?? "tool";
      toolNames.delete(block.tool_use_id);
      onProgress({
        message: `${block.is_error === true ? "Failed" : "Completed"} ${toolName}`
      });
    } else if (event.type === "assistant" && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      onProgress({
        message: block.text.trim().replace(/\s+/g, " ").slice(0, 240)
      });
    }
  }
}
function buildPrompt(options) {
  const executionMode = options.executionMode ?? "standard";
  const sections = [
    "This is an already approved implementation plan.",
    "",
    `Working directory: ${options.workingDirectory}`,
    "",
    "## Plan",
    options.plan,
    "",
    "## Workspace Before Execution",
    JSON.stringify(options.workspaceBefore, null, 2)
  ];
  if (options.acceptanceCriteria && options.acceptanceCriteria.length > 0) {
    sections.push("", "## Acceptance Criteria");
    for (const criteria of options.acceptanceCriteria) {
      sections.push(`- ${criteria}`);
    }
  }
  sections.push(
    "",
    "## Instructions",
    "- Preserve all pre-existing user changes.",
    "- Do not revert, reset, clean, checkout, commit, push, or deploy.",
    "- Do not modify unrelated files.",
    "- Do not access files outside the working directory.",
    "- This is a non-interactive execution. Never use AskUserQuestion or wait for user input.",
    "- Make reasonable implementation decisions when they are safe and consistent with the approved plan.",
    "- If essential information is missing, return status `error` and describe exactly what information is required.",
    "- Keep long-running work in the foreground so the executor can track it. Do not leave the main implementation running in a detached or background process.",
    "- For commands that may run for several minutes, prefer periodic progress output or split the work into recoverable checkpoints.",
    "- Run relevant tests, builds, and linters when allowed by the tool permissions.",
    "- Do not run previews or browser verification; Codex will perform visual and browser checks.",
    "- Return status `error` if implementation cannot be completed or any required test, build, lint, or typecheck fails.",
    "",
    "## Reporting",
    "At the end, report:",
    "- Changed files",
    "- Commands executed",
    "- Test, build, and lint results",
    "- Unresolved issues"
  );
  if (executionMode === "claude_write_only") {
    sections.push(
      "",
      "## Collaboration Mode",
      "- Codex is acting as planner and reviewer only.",
      "- Claude must perform every code change inside this execution.",
      "- Do not assume Codex will manually patch your output after this run.",
      "- If the review later finds issues, expect a follow-up plan instead of a manual Codex fix."
    );
  }
  return sections.join("\n");
}
function startClaude(options, hooks = {}) {
  const claudeBin = options.claudeBin ?? process.env.CLAUDE_BIN ?? "claude";
  const startTime = Date.now();
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--no-chrome",
    "--json-schema",
    RESULT_SCHEMA,
    "--allowedTools",
    options.allowedTools.join(",")
  ];
  const env = { ...process.env, ...options.env };
  const prompt = buildPrompt(options);
  let process_ref = null;
  let processClosed = false;
  let stopReason = null;
  const completed = new Promise((resolve) => {
    let timeoutId = null;
    let sigtermTimeoutId = null;
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let resolved = false;
    let stdoutLineBuffer = "";
    let stdoutLineOverflow = false;
    let finalResultEvent = null;
    const toolNames = /* @__PURE__ */ new Map();
    const consumeStdoutLine = (line) => {
      const event = parseJsonLine(line);
      if (isRecord(event) && event.type === "result") {
        finalResultEvent = event;
      }
      emitProgressFromEvent(event, toolNames, hooks.onProgress);
    };
    const consumeStdoutChunk = (chunk) => {
      if (stdoutLineOverflow) {
        const newlineIndex = chunk.search(/\r?\n/);
        if (newlineIndex < 0) return;
        stdoutLineOverflow = false;
        chunk = chunk.slice(newlineIndex + 1);
      }
      stdoutLineBuffer += chunk;
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        consumeStdoutLine(line);
      }
      if (Buffer.byteLength(stdoutLineBuffer) > MAX_OUTPUT_SIZE) {
        stdoutLineBuffer = "";
        stdoutLineOverflow = true;
      }
    };
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (sigtermTimeoutId) {
        clearTimeout(sigtermTimeoutId);
        sigtermTimeoutId = null;
      }
    };
    const resolveOnce = (result) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve(result);
      }
    };
    const signalProcess = (signal) => {
      if (!process_ref?.pid || processClosed) return;
      if (process.platform !== "win32") {
        try {
          process.kill(-process_ref.pid, signal);
          return;
        } catch {
        }
      }
      process_ref.kill(signal);
    };
    try {
      process_ref = spawn(claudeBin, args, {
        cwd: options.workingDirectory,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        env,
        detached: process.platform !== "win32"
      });
    } catch (error) {
      resolveOnce({
        status: "environment_error",
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startTime,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        parsedOutput: null,
        error: `Failed to spawn Claude process: ${error instanceof Error ? error.message : String(error)}`
      });
      return;
    }
    process_ref.stdin?.write(prompt);
    process_ref.stdin?.end();
    process_ref.stdout?.on("data", (data) => {
      const chunk = data.toString();
      hooks.onStdout?.(chunk);
      consumeStdoutChunk(chunk);
      if (stdout.length < MAX_OUTPUT_SIZE) {
        stdout += chunk;
        if (stdout.length > MAX_OUTPUT_SIZE) {
          stdout = stdout.slice(0, MAX_OUTPUT_SIZE);
          stdoutTruncated = true;
        }
      } else {
        stdoutTruncated = true;
      }
    });
    process_ref.stderr?.on("data", (data) => {
      const chunk = data.toString();
      hooks.onStderr?.(chunk);
      if (stderr.length < MAX_OUTPUT_SIZE) {
        stderr += chunk;
        if (stderr.length > MAX_OUTPUT_SIZE) {
          stderr = stderr.slice(0, MAX_OUTPUT_SIZE);
          stderrTruncated = true;
        }
      } else {
        stderrTruncated = true;
      }
    });
    if (options.timeoutSeconds > 0) {
      timeoutId = setTimeout(() => {
        stopReason = "timeout";
        signalProcess("SIGTERM");
        sigtermTimeoutId = setTimeout(() => {
          signalProcess("SIGKILL");
        }, SIGTERM_WAIT_MS);
      }, options.timeoutSeconds * 1e3);
    }
    process_ref.on("close", (code, signal) => {
      processClosed = true;
      if (resolved) return;
      cleanup();
      const durationMs = Date.now() - startTime;
      if (stdoutLineBuffer.trim()) {
        consumeStdoutLine(stdoutLineBuffer);
      }
      if (stopReason === "timeout") {
        resolveOnce({
          status: "timed_out",
          exitCode: code,
          signal,
          durationMs,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          parsedOutput: null,
          error: `Execution timed out after ${options.timeoutSeconds} seconds`
        });
        return;
      }
      if (stopReason === "cancelled") {
        resolveOnce({
          status: "cancelled",
          exitCode: code,
          signal,
          durationMs,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          parsedOutput: null,
          error: "Execution was cancelled"
        });
        return;
      }
      let parsedOutput = null;
      let parseError = null;
      parsedOutput = finalResultEvent ?? parseClaudeOutput(stdout);
      if (code === 0 && parsedOutput === null) {
        parseError = "Invalid JSON output from Claude despite zero exit code";
      }
      let status;
      let error = parseError;
      if (code === 0 && isClaudeSuccessResult(parsedOutput)) {
        status = "completed";
      } else if (code === 0 && isClaudeErrorResult(parsedOutput)) {
        status = "failed";
        error = getClaudeErrorMessage(parsedOutput);
      } else if (code === 0) {
        status = "failed";
        error = parseError ?? "Claude did not return the required final structured success result";
      } else {
        status = "failed";
        if (!error) {
          error = `Claude process exited with code ${code}`;
        }
      }
      resolveOnce({
        status,
        exitCode: code,
        signal,
        durationMs,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        parsedOutput,
        error
      });
    });
    process_ref.on("error", (error) => {
      if (resolved) return;
      cleanup();
      resolveOnce({
        status: "environment_error",
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startTime,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        parsedOutput: null,
        error: `Failed to spawn Claude process: ${error.message}`
      });
    });
  });
  return {
    cancel: () => {
      if (processClosed || stopReason === "timeout" || stopReason === "cancelled") {
        return;
      }
      stopReason = "cancelled";
      if (!process_ref?.pid) {
        return;
      }
      if (process.platform !== "win32") {
        try {
          process.kill(-process_ref.pid, "SIGTERM");
        } catch {
          process_ref.kill("SIGTERM");
        }
      } else {
        process_ref.kill("SIGTERM");
      }
      setTimeout(() => {
        if (!processClosed) {
          if (process.platform !== "win32") {
            try {
              process.kill(-process_ref.pid, "SIGKILL");
            } catch {
              process_ref?.kill("SIGKILL");
            }
          } else {
            process_ref?.kill("SIGKILL");
          }
        }
      }, SIGTERM_WAIT_MS);
    },
    completed,
    getPid: () => process_ref?.pid ?? null
  };
}

// src/workspace.ts
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
async function execCommand(command, args, cwd) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout: 15e3 },
      (error, stdout, stderr) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(stdout.toString());
      }
    );
  });
}
async function captureWorkspaceSnapshot(directory) {
  const stat3 = await fs.stat(directory);
  if (!stat3.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${directory}`);
  }
  const toplevel = await execCommand(
    "git",
    ["-C", directory, "rev-parse", "--show-toplevel"],
    directory
  );
  if (toplevel === null) {
    return {
      kind: "non_git",
      note: "Directory is not inside a Git repository; automatic change tracking is unavailable."
    };
  }
  const repositoryRoot = toplevel.trim();
  const statusShort = await execCommand(
    "git",
    ["-C", repositoryRoot, "status", "--short", "--untracked-files=all"],
    directory
  ) ?? "";
  const unstagedDiffStat = await execCommand(
    "git",
    ["-C", repositoryRoot, "diff", "--stat"],
    directory
  ) ?? "";
  const stagedDiffStat = await execCommand(
    "git",
    ["-C", repositoryRoot, "diff", "--cached", "--stat"],
    directory
  ) ?? "";
  return {
    kind: "git",
    repositoryRoot,
    statusShort,
    unstagedDiffStat,
    stagedDiffStat
  };
}

// src/job-store.ts
import * as fs2 from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
var DEFAULT_JOB_ROOT = path.join(
  os.homedir(),
  ".codex",
  "claude-executor",
  "jobs"
);
var DEFAULT_STALL_MS = 15 * 60 * 1e3;
var DEFAULT_LOG_LIMIT_BYTES = 20 * 1024 * 1024;
var TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1e3;
function jobDirectory(root2, jobId2) {
  return path.join(root2, jobId2);
}
function jobPath(root2, jobId2, name) {
  return path.join(jobDirectory(root2, jobId2), name);
}
async function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs2.writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf-8");
  await fs2.rename(temporaryPath, filePath);
}
async function readJson(filePath) {
  return JSON.parse(await fs2.readFile(filePath, "utf-8"));
}
async function readStatus(root2, jobId2) {
  return readJson(jobPath(root2, jobId2, "status.json"));
}
async function writeStatus(root2, jobId2, status) {
  await atomicWriteJson(jobPath(root2, jobId2, "status.json"), status);
}
async function readRequest(root2, jobId2) {
  return readJson(jobPath(root2, jobId2, "request.json"));
}
async function writeResult(root2, jobId2, result) {
  await atomicWriteJson(jobPath(root2, jobId2, "result.json"), result);
}
function isTerminalStatus(status) {
  return [
    "completed",
    "failed",
    "timed_out",
    "cancelled",
    "environment_error"
  ].includes(status);
}
function workspaceLockPath(root2, workingDirectory) {
  const hash = createHash("sha256").update(workingDirectory).digest("hex");
  return path.join(root2, ".locks", `${hash}.lock`);
}
async function removeWorkspaceLock(root2, workingDirectory, expectedJobId) {
  const lockPath = workspaceLockPath(root2, workingDirectory);
  if (expectedJobId) {
    try {
      const currentJobId = (await fs2.readFile(lockPath, "utf-8")).trim();
      if (currentJobId !== expectedJobId) return;
    } catch {
      return;
    }
  }
  await fs2.rm(lockPath, { force: true });
}
async function safeWorkspaceSnapshot(workingDirectory, capture) {
  try {
    return await capture(workingDirectory);
  } catch (error) {
    return {
      kind: "non_git",
      note: `Workspace snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
async function appendCappedLog(filePath, chunk, limitBytes) {
  const chunkBuffer = Buffer.from(chunk);
  await fs2.appendFile(filePath, chunkBuffer);
  const stat3 = await fs2.stat(filePath);
  if (stat3.size <= limitBytes) return false;
  const retainedBytes = Math.max(
    Math.floor(limitBytes / 2),
    Math.min(limitBytes, chunkBuffer.length)
  );
  const handle = await fs2.open(filePath, "r");
  const retained = Buffer.alloc(retainedBytes);
  try {
    await handle.read(retained, 0, retainedBytes, stat3.size - retainedBytes);
  } finally {
    await handle.close();
  }
  await fs2.writeFile(filePath, retained);
  return true;
}

// src/job-worker.ts
var root = process.argv[2];
var jobId = process.argv[3];
if (!root || !jobId) {
  console.error("Usage: job-worker <job-root> <job-id>");
  process.exit(1);
}
var cancelled = false;
var currentRun = null;
process.on("SIGTERM", () => {
  cancelled = true;
  currentRun?.cancel();
});
process.on("SIGINT", () => {
  cancelled = true;
  currentRun?.cancel();
});
function failureKindFor(result) {
  if (result.status === "environment_error") return "worker_error";
  if (result.error?.includes("structured success") || result.error?.includes("Invalid JSON")) {
    return "invalid_result";
  }
  return result.status === "failed" ? "claude_error" : null;
}
async function main() {
  const startFlag = jobPath(root, jobId, "start.flag");
  const cancelFlag = jobPath(root, jobId, "cancel.flag");
  const startDeadline = Date.now() + 5e3;
  while (Date.now() < startDeadline) {
    try {
      await fs3.access(startFlag);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const request = await readRequest(root, jobId);
  let status = await readStatus(root, jobId);
  try {
    await fs3.access(cancelFlag);
    cancelled = true;
  } catch {
  }
  const stdoutPath = jobPath(root, jobId, "stdout.log");
  const stderrPath = jobPath(root, jobId, "stderr.log");
  let logQueue = Promise.resolve();
  let stalled = false;
  let stallTimer = null;
  let persistQueue = Promise.resolve();
  let lastActivityPersistedAt = 0;
  const persist = () => {
    persistQueue = persistQueue.then(() => writeStatus(root, jobId, status));
    return persistQueue;
  };
  const activity = (message) => {
    status.lastActivityAt = (/* @__PURE__ */ new Date()).toISOString();
    if (message) {
      status.progress = {
        eventCount: (status.progress?.eventCount ?? 0) + 1,
        message,
        updatedAt: status.lastActivityAt
      };
    }
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      currentRun?.cancel();
    }, request.stallMs);
    if (Date.now() - lastActivityPersistedAt >= 250) {
      lastActivityPersistedAt = Date.now();
      void persist();
    }
  };
  const append = (stream, chunk) => {
    activity();
    const filePath = stream === "stdout" ? stdoutPath : stderrPath;
    logQueue = logQueue.then(async () => {
      const truncated = await appendCappedLog(
        filePath,
        chunk,
        request.logLimitBytes
      );
      if (truncated) status.logsTruncated[stream] = true;
    });
  };
  try {
    while (status.attempt < status.maxAttempts && !cancelled) {
      status.attempt += 1;
      status.status = "running";
      status.workerPid = process.pid;
      status.currentPid = null;
      status.failureKind = null;
      activity(`Claude attempt ${status.attempt} started`);
      await persist();
      currentRun = startClaude(
        {
          workingDirectory: request.workingDirectory,
          plan: request.plan,
          acceptanceCriteria: request.acceptanceCriteria,
          allowedTools: request.allowedTools,
          executionMode: request.executionMode,
          timeoutSeconds: 0,
          workspaceBefore: request.workspaceBefore,
          claudeBin: request.claudeBin,
          env: request.env
        },
        {
          onStdout: (chunk) => append("stdout", chunk),
          onStderr: (chunk) => append("stderr", chunk),
          onProgress: (event) => activity(event.message)
        }
      );
      status.currentPid = currentRun.getPid();
      await persist();
      const runResult = await currentRun.completed;
      currentRun = null;
      if (stallTimer) clearTimeout(stallTimer);
      await logQueue;
      await persistQueue;
      if (cancelled && !stalled) {
        await finish({
          ...runResult,
          status: "cancelled",
          error: "Execution was cancelled"
        }, null);
        return;
      }
      if (stalled) {
        if (status.attempt < status.maxAttempts) {
          status.status = "restarting";
          status.failureKind = "stalled";
          status.progress = {
            eventCount: (status.progress?.eventCount ?? 0) + 1,
            message: `Claude stalled; restarting attempt ${status.attempt + 1} of ${status.maxAttempts}`,
            updatedAt: (/* @__PURE__ */ new Date()).toISOString()
          };
          stalled = false;
          await persist();
          continue;
        }
        await finish(
          {
            ...runResult,
            status: "failed",
            error: `Claude made no progress for ${request.stallMs}ms across ${status.maxAttempts} attempts. Last progress: ${status.progress?.message ?? "none"}. Logs: ${stdoutPath}, ${stderrPath}`
          },
          "stalled"
        );
        return;
      }
      await finish(runResult, failureKindFor(runResult));
      return;
    }
    if (cancelled) {
      await finish(
        {
          status: "cancelled",
          exitCode: null,
          signal: "SIGTERM",
          durationMs: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          parsedOutput: null,
          error: "Execution was cancelled"
        },
        null
      );
    }
  } catch (error) {
    const fallback = {
      status: "environment_error",
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      parsedOutput: null,
      error: `Worker failed: ${error instanceof Error ? error.message : String(error)}`
    };
    await finish(fallback, "worker_error");
  }
  async function finish(runResult, failureKind) {
    if (stallTimer) clearTimeout(stallTimer);
    const workspaceAfter = await safeWorkspaceSnapshot(
      request.workingDirectory,
      captureWorkspaceSnapshot
    );
    const result = {
      ...runResult,
      jobId,
      workingDirectory: request.workingDirectory,
      allowedTools: request.allowedTools,
      executionMode: request.executionMode,
      workspaceBefore: request.workspaceBefore,
      workspaceAfter
    };
    status = {
      ...status,
      status: result.status,
      finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
      workspaceAfter,
      result,
      currentPid: null,
      workerPid: null,
      failureKind
    };
    await writeResult(root, jobId, result);
    await writeStatus(root, jobId, status);
    await removeWorkspaceLock(root, request.workingDirectory, jobId);
  }
}
main().catch(async (error) => {
  try {
    const status = await readStatus(root, jobId);
    if (!isTerminalStatus(status.status)) {
      const workspaceAfter = await safeWorkspaceSnapshot(
        status.workingDirectory,
        captureWorkspaceSnapshot
      );
      const message = `Worker failed: ${error instanceof Error ? error.message : String(error)}`;
      status.status = "environment_error";
      status.failureKind = "worker_error";
      status.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
      status.workerPid = null;
      status.currentPid = null;
      status.workspaceAfter = workspaceAfter;
      status.result = {
        jobId,
        status: "environment_error",
        exitCode: null,
        signal: null,
        durationMs: 0,
        stdout: "",
        stderr: "",
        stdoutTruncated: status.logsTruncated.stdout,
        stderrTruncated: status.logsTruncated.stderr,
        parsedOutput: null,
        error: message,
        workingDirectory: status.workingDirectory,
        allowedTools: status.allowedTools,
        executionMode: status.executionMode,
        workspaceBefore: status.workspaceBefore,
        workspaceAfter
      };
      await writeResult(root, jobId, status.result);
      await atomicWriteJson(jobPath(root, jobId, "status.json"), status);
      await removeWorkspaceLock(root, status.workingDirectory, jobId);
    }
  } finally {
    console.error(error);
    process.exit(1);
  }
});
