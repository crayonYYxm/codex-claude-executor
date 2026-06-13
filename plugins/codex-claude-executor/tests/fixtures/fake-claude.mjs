#!/usr/bin/env node

/**
 * Fake Claude fixture for testing.
 *
 * Supports environment-controlled scenarios:
 * - FAKE_CLAUDE_MODE=success
 * - FAKE_CLAUDE_MODE=failure
 * - FAKE_CLAUDE_MODE=invalid-json
 * - FAKE_CLAUDE_MODE=timeout
 * - FAKE_CLAUDE_MODE=slow-success
 * - FAKE_CLAUDE_MODE=stream-progress
 * - FAKE_CLAUDE_MODE=thinking-progress
 * - FAKE_CLAUDE_MODE=result-error
 * - FAKE_CLAUDE_MODE=structured-error
 * - FAKE_CLAUDE_MODE=large-output
 * - FAKE_CLAUDE_MODE=auth-success
 * - FAKE_CLAUDE_MODE=auth-failure
 */

import { readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";

const mode = process.env.FAKE_CLAUDE_MODE || "success";

// Handle --version flag
if (process.argv.includes("--version")) {
  console.log("fake-claude version 1.0.0 (test fixture)");
  process.exit(0);
}

// Handle auth status --json
if (
  process.argv.includes("auth") &&
  process.argv.includes("status") &&
  process.argv.includes("--json")
) {
  if (mode === "auth-success") {
    console.log(JSON.stringify({ loggedIn: true, authMethod: "api-key" }));
    process.exit(0);
  } else if (mode === "auth-failure") {
    console.log(JSON.stringify({ loggedIn: false, authMethod: null }));
    process.exit(0);
  }
  // Default auth behavior based on mode
  if (mode === "success" || mode === "large-output" || mode === "slow-success") {
    console.log(JSON.stringify({ loggedIn: true, authMethod: "api-key" }));
  } else {
    console.log(JSON.stringify({ loggedIn: false, authMethod: null }));
  }
  process.exit(0);
}

// Read prompt from stdin
let prompt = "";
try {
  prompt = readFileSync(0, "utf-8");
} catch (e) {
  // stdin might be empty
}

// Handle different modes
switch (mode) {
  case "success": {
    const result = {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Plan executed successfully",
      structured_output: {
        status: "success",
        summary: "Plan executed successfully",
        changedFiles: ["src/example.ts"],
        commandsExecuted: ["npm test"],
        checks: ["npm test passed"],
      },
      args: process.argv.slice(2),
      prompt,
    };
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  case "failure": {
    const result = {
      status: "failure",
      message: "Execution failed",
      error: "Test failures detected",
    };
    console.log(JSON.stringify(result));
    process.exit(1);
  }

  case "invalid-json": {
    console.log("This is not valid JSON output");
    process.exit(0);
  }

  case "timeout": {
    // Block stdin to keep process alive, simulating a hanging process
    process.stdin.resume();
    // Keep process alive with a long-running timer
    const interval = setInterval(() => {}, 2147483647);
    // Clean up on SIGTERM
    process.on("SIGTERM", () => {
      clearInterval(interval);
      process.exit(1);
    });
    break;
  }

  case "stall-then-success": {
    const attemptFile = process.env.FAKE_CLAUDE_ATTEMPT_FILE;
    let attempt = 0;
    try {
      attempt = Number(readFileSync(attemptFile, "utf-8"));
    } catch {}
    attempt += 1;
    writeFileSync(attemptFile, String(attempt));
    if (attempt < 3) {
      process.on("SIGTERM", () => process.exit(0));
      setInterval(() => {}, 60_000);
      break;
    }
    console.log(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Recovered after stalls.",
        structured_output: {
          status: "success",
          summary: "Recovered after stalls.",
        },
      })
    );
    process.exit(0);
  }

  case "delete-workspace": {
    rmSync(process.cwd(), { recursive: true, force: true });
    console.log(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Workspace removed.",
        structured_output: {
          status: "success",
          summary: "Workspace removed.",
        },
      })
    );
    process.exit(0);
  }

  case "slow-success": {
    let cancelled = false;
    process.on("SIGTERM", () => {
      cancelled = true;
      process.stderr.write("received SIGTERM\n");
      process.exit(0);
    });

    process.stderr.write("starting execution\n");
    setTimeout(() => {
      if (cancelled) return;
      process.stderr.write("still running\n");
    }, 150);
    setTimeout(() => {
      if (cancelled) return;
      const result = {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Slow plan executed successfully",
        structured_output: {
          status: "success",
          summary: "Slow plan executed successfully",
        },
        prompt,
      };
      process.stdout.write(JSON.stringify(result));
      process.exit(0);
    }, 350);
    break;
  }

  case "stream-progress": {
    const events = [
      {
        type: "system",
        subtype: "init",
        session_id: "fake-session",
      },
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "Write",
              input: { file_path: "src/example.ts" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-1",
              content: "File written",
              is_error: false,
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Implementation complete." }],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Implemented the requested change.",
        structured_output: {
          status: "success",
          summary: "Implemented the requested change.",
        },
      },
    ];

    events.forEach((event, index) => {
      setTimeout(() => {
        process.stdout.write(`${JSON.stringify(event)}\n`);
        if (index === events.length - 1) {
          process.exit(0);
        }
      }, index * 40);
    });
    break;
  }

  case "thinking-progress": {
    const events = [
      {
        type: "system",
        subtype: "init",
        session_id: "fake-session",
      },
      {
        type: "system",
        subtype: "thinking_tokens",
        estimated_tokens: 128,
        estimated_tokens_delta: 8,
        session_id: "fake-session",
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Implemented the requested change.",
        structured_output: {
          status: "success",
          summary: "Implemented the requested change.",
        },
      },
    ];

    events.forEach((event, index) => {
      setTimeout(() => {
        process.stdout.write(`${JSON.stringify(event)}\n`);
        if (index === events.length - 1) {
          process.exit(0);
        }
      }, index * 40);
    });
    break;
  }

  case "result-error": {
    console.log(
      JSON.stringify({
        type: "result",
        subtype: "error",
        is_error: true,
        result: "Claude could not complete the task.",
      })
    );
    process.exit(0);
  }

  case "result-without-structured-output": {
    console.log(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Finished without the required structured output.",
      })
    );
    process.exit(0);
  }

  case "structured-error": {
    console.log(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "I could not complete the required checks.",
        structured_output: {
          status: "error",
          summary: "Implementation stopped because the required test command failed.",
          error: "npm test failed with 2 failing tests",
        },
      })
    );
    process.exit(0);
  }

  case "ignore-sigterm": {
    writeFileSync(process.env.FAKE_CLAUDE_PID_FILE, String(process.pid));
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 60_000);
    break;
  }

  case "delayed-output": {
    spawn(
      process.execPath,
      [
        "-e",
        "setTimeout(() => { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { status: 'success', summary: 'done' } })); }, 100)",
      ],
      {
        stdio: ["ignore", "inherit", "inherit"],
      }
    );
    process.exit(0);
  }

  case "large-output": {
    // Generate 3 MiB of output to test truncation
    const chunk = "x".repeat(1024);
    let i = 0;
    function writeChunk() {
      while (i < 3072) {
        if (!process.stdout.write(chunk)) {
          i++;
          process.stdout.once("drain", writeChunk);
          return;
        }
        i++;
      }
      // All chunks written, now write the final JSON
      process.stdout.write("\n" + JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { status: "success", summary: "done" } }) + "\n", () => {
        process.exit(0);
      });
    }
    writeChunk();
    break;
  }

  case "auth-success": {
    // Already handled above
    const result = {
      status: "success",
      message: "Authenticated and executed",
    };
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  case "auth-failure": {
    // Already handled above
    process.exit(1);
  }

  default: {
    console.error(`Unknown FAKE_CLAUDE_MODE: ${mode}`);
    process.exit(1);
  }
}
