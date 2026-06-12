#!/usr/bin/env node

/**
 * Fake Claude fixture for testing.
 *
 * Supports environment-controlled scenarios:
 * - FAKE_CLAUDE_MODE=success
 * - FAKE_CLAUDE_MODE=failure
 * - FAKE_CLAUDE_MODE=invalid-json
 * - FAKE_CLAUDE_MODE=timeout
 * - FAKE_CLAUDE_MODE=large-output
 * - FAKE_CLAUDE_MODE=auth-success
 * - FAKE_CLAUDE_MODE=auth-failure
 */

import { readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
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
  if (mode === "success" || mode === "large-output") {
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
      status: "success",
      message: "Plan executed successfully",
      changedFiles: ["src/example.ts"],
      commandsRun: ["npm test"],
      testResults: { passed: 5, failed: 0 },
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
        "setTimeout(() => { process.stdout.write(JSON.stringify({ status: 'success' })); }, 100)",
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
      process.stdout.write("\n" + JSON.stringify({ status: "success" }) + "\n", () => {
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
