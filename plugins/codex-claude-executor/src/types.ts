export type ExecutionStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "environment_error";

export type GitWorkspaceSnapshot = {
  kind: "git";
  repositoryRoot: string;
  statusShort: string;
  unstagedDiffStat: string;
  stagedDiffStat: string;
};

export type NonGitWorkspaceSnapshot = {
  kind: "non_git";
  note: string;
};

export type WorkspaceSnapshot = GitWorkspaceSnapshot | NonGitWorkspaceSnapshot;

export type ClaudeRunResult = {
  status: ExecutionStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  parsedOutput: unknown | null;
  error: string | null;
};

export type ExecutePlanResult = ClaudeRunResult & {
  workingDirectory: string;
  allowedTools: string[];
  workspaceBefore: WorkspaceSnapshot;
  workspaceAfter: WorkspaceSnapshot;
};

export type EnvironmentCheckResult = {
  ready: boolean;
  nodeVersion: string;
  claudeBin: string;
  claudeVersion: string | null;
  authenticated: boolean;
  authMethod: string | null;
  errors: string[];
};

export type ExecutePlanInput = {
  workingDirectory: string;
  plan: string;
  acceptanceCriteria?: string[];
  extraAllowedTools?: string[];
  timeoutSeconds?: number;
};
