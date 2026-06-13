export type BenchmarkVariant = "direct" | "plugin";
export type ExecutionMode = "standard" | "claude_write_only";

export type TokenUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
};

export type BenchmarkResult = {
  variant: BenchmarkVariant;
  runIndex: number;
  sessionId: string | null;
  transcriptPath: string;
  workspacePath: string;
  tokenUsage: TokenUsage;
  durationMs: number;
  executorUsed: boolean;
};

export function extractSessionIdFromJsonl(text: string): string | null;
export function extractLatestTokenUsageFromJsonl(text: string): TokenUsage;
export function detectExecutorUsage(text: string): boolean;
export function buildVariantPrompt(
  basePrompt: string,
  variant: BenchmarkVariant,
  executionMode?: ExecutionMode,
  pluginId?: string
): string;
export function summarizeBenchmarks(results: BenchmarkResult[]): {
  direct: {
    runCount: number;
    mean: TokenUsage;
    min: TokenUsage;
    max: TokenUsage;
    mean_duration_ms: number;
  };
  plugin: {
    runCount: number;
    mean: TokenUsage;
    min: TokenUsage;
    max: TokenUsage;
    mean_duration_ms: number;
  };
  delta: Record<string, number | null>;
};
export function runCodexBenchmarkOnce(options: {
  artifactsRoot: string;
  basePrompt: string;
  codexBin?: string;
  executionMode?: ExecutionMode;
  model?: string | null;
  pluginId?: string;
  runIndex: number;
  variant: BenchmarkVariant;
  workspaceTemplate: string;
}): Promise<BenchmarkResult>;
