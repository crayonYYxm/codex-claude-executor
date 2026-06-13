import { describe, expect, it } from "vitest";
import { isExecutionResponseError } from "../src/server.js";

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
});
