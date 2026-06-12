/**
 * Workspace module for path validation and Git state inspection.
 *
 * Handles working directory validation and capturing
 * pre/post-execution workspace snapshots.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import type { WorkspaceSnapshot } from "./types.js";

/**
 * Resolve and validate a working directory path.
 *
 * Rules:
 * 1. Require an absolute input path
 * 2. Resolve symlinks using realpath
 * 3. Require the resolved path to exist and be a directory
 * 4. Reject the filesystem root directory
 * 5. Return the resolved absolute path
 */
export async function resolveWorkingDirectory(
  inputPath: string
): Promise<string> {
  // Require absolute path
  if (!path.isAbsolute(inputPath)) {
    throw new Error("Working directory must be an absolute path");
  }

  // Reject filesystem root
  if (inputPath === "/") {
    throw new Error("Working directory cannot be the filesystem root");
  }

  // Resolve symlinks
  let resolved: string;
  try {
    resolved = await fs.realpath(inputPath);
  } catch (error) {
    throw new Error(
      `Working directory does not exist: ${inputPath}`
    );
  }

  // Reject aliases, symlinks, and normalized paths that resolve to root.
  if (resolved === path.parse(resolved).root) {
    throw new Error("Working directory cannot be the filesystem root");
  }

  // Verify it's a directory
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error("Working directory is not a directory");
  }

  return resolved;
}

/**
 * Execute a command without shell, returning stdout.
 * Returns null on any error.
 */
async function execCommand(
  command: string,
  args: string[],
  cwd: string
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout: 15000 },
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

/**
 * Capture a workspace snapshot for the given directory.
 *
 * For Git repositories, captures:
 * - Repository root
 * - Git status (short format, untracked files)
 * - Unstaged diff stat
 * - Staged diff stat
 *
 * For non-Git directories, returns a note indicating
 * automatic change tracking is unavailable.
 */
export async function captureWorkspaceSnapshot(
  directory: string
): Promise<WorkspaceSnapshot> {
  // Check if this is a Git repository
  const toplevel = await execCommand(
    "git",
    ["-C", directory, "rev-parse", "--show-toplevel"],
    directory
  );

  if (toplevel === null) {
    return {
      kind: "non_git",
      note: "Directory is not inside a Git repository; automatic change tracking is unavailable.",
    };
  }

  const repositoryRoot = toplevel.trim();

  // Capture git status
  const statusShort =
    (await execCommand(
      "git",
      ["-C", repositoryRoot, "status", "--short", "--untracked-files=all"],
      directory
    )) ?? "";

  // Capture unstaged diff stat
  const unstagedDiffStat =
    (await execCommand(
      "git",
      ["-C", repositoryRoot, "diff", "--stat"],
      directory
    )) ?? "";

  // Capture staged diff stat
  const stagedDiffStat =
    (await execCommand(
      "git",
      ["-C", repositoryRoot, "diff", "--cached", "--stat"],
      directory
    )) ?? "";

  return {
    kind: "git",
    repositoryRoot,
    statusShort,
    unstagedDiffStat,
    stagedDiffStat,
  };
}
