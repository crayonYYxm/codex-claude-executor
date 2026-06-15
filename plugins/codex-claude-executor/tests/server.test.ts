import { describe, expect, it } from "vitest";
import {
  isExecutionResponseError,
  SERVER_INSTRUCTIONS,
} from "../src/server.js";

describe("server execution response classification", () => {
  it("does not report active persistent states as MCP errors", () => {
    expect(isExecutionResponseError("running")).toBe(false);
    expect(isExecutionResponseError("restarting")).toBe(false);
    expect(isExecutionResponseError("cancelling")).toBe(false);
  });

  it("reports terminal failures as MCP errors", () => {
    expect(isExecutionResponseError("completed")).toBe(false);
    expect(isExecutionResponseError("failed")).toBe(true);
    expect(isExecutionResponseError("environment_error")).toBe(true);
    expect(isExecutionResponseError("cancelled")).toBe(true);
  });

  it("documents that active claude_write_only jobs forbid Codex file edits", () => {
    expect(SERVER_INSTRUCTIONS).toContain(
      "Partial workspace diffs during these active states are not permission for Codex to intervene or patch code."
    );
    expect(SERVER_INSTRUCTIONS).toContain(
      "while the job remains running, restarting, or cancelling, Codex must not modify files in that workspace"
    );
  });
});
