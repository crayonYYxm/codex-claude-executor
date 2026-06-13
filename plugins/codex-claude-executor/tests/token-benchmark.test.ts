import { describe, expect, it } from "vitest";
import {
  buildVariantPrompt,
  detectExecutorUsage,
  extractLatestTokenUsageFromJsonl,
  extractSessionIdFromJsonl,
  summarizeBenchmarks,
} from "../scripts/lib/codex-token-benchmark.js";

describe("codex token benchmark helpers", () => {
  it("extracts the latest token_count event from a Codex JSONL transcript", () => {
    const transcript = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "session-123" },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 2,
              output_tokens: 3,
              reasoning_output_tokens: 1,
              total_tokens: 13,
            },
          },
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 20,
              cached_input_tokens: 4,
              output_tokens: 5,
              reasoning_output_tokens: 2,
              total_tokens: 25,
            },
          },
        },
      }),
    ].join("\n");

    expect(extractSessionIdFromJsonl(transcript)).toBe("session-123");
    expect(extractLatestTokenUsageFromJsonl(transcript)).toEqual({
      input_tokens: 20,
      cached_input_tokens: 4,
      output_tokens: 5,
      reasoning_output_tokens: 2,
      total_tokens: 25,
    });
  });

  it("detects whether codex-claude-executor tools were used", () => {
    const directTranscript = JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
      },
    });

    const delegatedTranscript = [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "check_environment",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "start_execution",
        },
      }),
    ].join("\n");

    expect(detectExecutorUsage(directTranscript)).toBe(false);
    expect(detectExecutorUsage(delegatedTranscript)).toBe(true);
  });

  it("builds variant prompts that force the intended execution path", () => {
    const basePrompt = "Implement the requested change.";

    expect(buildVariantPrompt(basePrompt, "direct")).toContain(
      "Do not use the codex-claude-executor plugin"
    );
    expect(buildVariantPrompt(basePrompt, "plugin")).toContain(
      "[@codex-claude-executor](plugin://codex-claude-executor@crayonyyxm)"
    );
    expect(
      buildVariantPrompt(basePrompt, "plugin", "claude_write_only")
    ).toContain('executionMode to "claude_write_only"');
  });

  it("summarizes benchmark runs by variant", () => {
    const summary = summarizeBenchmarks([
      {
        variant: "direct",
        runIndex: 1,
        sessionId: "a",
        transcriptPath: "/tmp/direct-1.jsonl",
        workspacePath: "/tmp/direct-1",
        tokenUsage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          output_tokens: 10,
          reasoning_output_tokens: 5,
          total_tokens: 110,
        },
        durationMs: 1000,
        executorUsed: false,
      },
      {
        variant: "plugin",
        runIndex: 1,
        sessionId: "b",
        transcriptPath: "/tmp/plugin-1.jsonl",
        workspacePath: "/tmp/plugin-1",
        tokenUsage: {
          input_tokens: 140,
          cached_input_tokens: 40,
          output_tokens: 20,
          reasoning_output_tokens: 8,
          total_tokens: 160,
        },
        durationMs: 2000,
        executorUsed: true,
      },
    ]);

    expect(summary.direct.runCount).toBe(1);
    expect(summary.plugin.mean.total_tokens).toBe(160);
    expect(summary.delta.total_tokens).toBe(50);
    expect(summary.delta.total_tokens_percent).toBeCloseTo(45.45, 2);
  });
});
