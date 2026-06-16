import { describe, expect, it } from "vitest";
import {
  classifyMonitoringTier,
  getAdaptiveHeartbeatIntervalMs,
  getAdaptiveStatusPollIntervalMs,
  isExecutionResponseError,
  SERVER_INSTRUCTIONS,
  shouldAllowDiagnosticLogRead,
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

  it("documents slower polling and diagnostic-only log reads", () => {
    expect(SERVER_INSTRUCTIONS).toContain(
      "Make the first status check after roughly 15 seconds"
    );
    expect(SERVER_INSTRUCTIONS).toContain(
      "non-terminal Claude jobs must never be finalized to the user as if the task were done"
    );
    expect(SERVER_INSTRUCTIONS).toContain(
      "long tasks can be checked as slowly as about every 5 minutes while they remain healthy"
    );
    expect(SERVER_INSTRUCTIONS).toContain(
      "Read execution logs only when progress stalls, after a restart, or when terminal diagnosis is needed"
    );
  });

  it("classifies monitoring tiers from plan length and acceptance criteria count", () => {
    expect(classifyMonitoringTier("x".repeat(1000), ["a", "b", "c"])).toBe(
      "short"
    );
    expect(classifyMonitoringTier("x".repeat(3000), Array(4).fill("a"))).toBe(
      "medium"
    );
    expect(classifyMonitoringTier("x".repeat(7000), ["a"])).toBe("long");
    expect(classifyMonitoringTier("x".repeat(1200), Array(9).fill("a"))).toBe(
      "long"
    );
  });

  it("returns adaptive status poll and heartbeat intervals by tier", () => {
    expect(getAdaptiveStatusPollIntervalMs("short")).toBe(60_000);
    expect(getAdaptiveStatusPollIntervalMs("medium")).toBe(120_000);
    expect(getAdaptiveStatusPollIntervalMs("long")).toBe(300_000);
    expect(getAdaptiveHeartbeatIntervalMs("short")).toBe(180_000);
    expect(getAdaptiveHeartbeatIntervalMs("medium")).toBe(240_000);
    expect(getAdaptiveHeartbeatIntervalMs("long")).toBe(300_000);
  });

  it("allows diagnostic log reads only for restarting, stalled, or terminal failures", () => {
    expect(
      shouldAllowDiagnosticLogRead({
        status: "restarting",
        failureKind: null,
        stagnantPolls: 0,
      })
    ).toBe(true);
    expect(
      shouldAllowDiagnosticLogRead({
        status: "failed",
        failureKind: "claude_error",
        stagnantPolls: 0,
      })
    ).toBe(true);
    expect(
      shouldAllowDiagnosticLogRead({
        status: "environment_error",
        failureKind: "worker_error",
        stagnantPolls: 0,
      })
    ).toBe(true);
    expect(
      shouldAllowDiagnosticLogRead({
        status: "running",
        failureKind: null,
        stagnantPolls: 2,
      })
    ).toBe(true);
    expect(
      shouldAllowDiagnosticLogRead({
        status: "running",
        failureKind: null,
        stagnantPolls: 0,
      })
    ).toBe(false);
  });
});
