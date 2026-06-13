export type ExecutionStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "environment_error";

export type ExecutionMode = "standard" | "claude_write_only";

export type ExecutionProgress = {
  eventCount: number;
  message: string;
  updatedAt: string;
};

export type JobStatus =
  | "running"
  | "restarting"
  | "cancelling"
  | ExecutionStatus;

export type FailureKind =
  | "claude_error"
  | "invalid_result"
  | "stalled"
  | "worker_error"
  | "workspace_error"
  | null;

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
  jobId?: string;
  workingDirectory: string;
  allowedTools: string[];
  executionMode: ExecutionMode;
  workspaceBefore: WorkspaceSnapshot;
  workspaceAfter: WorkspaceSnapshot;
};

export type ExecutePlanResponse =
  | ExecutePlanResult
  | ExecutionJobStatusResult;

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
  executionMode?: ExecutionMode;
  timeoutSeconds?: number;
};

export type StartExecutionResult = {
  jobId: string;
  status: JobStatus;
  workingDirectory: string;
  allowedTools: string[];
  executionMode: ExecutionMode;
  timeoutSeconds: number;
  createdAt: string;
  startedAt: string;
};

export type ExecutionJobStatusResult = {
  jobId: string;
  status: JobStatus;
  workingDirectory: string;
  allowedTools: string[];
  executionMode: ExecutionMode;
  timeoutSeconds: number;
  createdAt: string;
  startedAt: string;
  finishedAt: string | null;
  workspaceBefore: WorkspaceSnapshot;
  workspaceAfter: WorkspaceSnapshot | null;
  result: ExecutePlanResult | null;
  currentPid: number | null;
  workerPid: number | null;
  progress: ExecutionProgress | null;
  attempt: number;
  maxAttempts: number;
  lastActivityAt: string;
  recoveryCount: number;
  failureKind: FailureKind;
  logsTruncated: {
    stdout: boolean;
    stderr: boolean;
  };
};

export type ExecutionLogStream = "stdout" | "stderr";

export type ExecutionLogResult = {
  jobId: string;
  status: JobStatus;
  stream: ExecutionLogStream;
  offset: number;
  nextOffset: number;
  eof: boolean;
  text: string;
};
