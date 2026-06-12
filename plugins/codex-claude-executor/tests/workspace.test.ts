import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  resolveWorkingDirectory,
  captureWorkspaceSnapshot,
} from "../src/workspace.js";

describe("workspace", () => {
  let tempDir: string;

  beforeEach(async () => {
    const rawDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-test-"));
    // Resolve symlinks (macOS /tmp -> /private/tmp) for consistent comparison
    tempDir = await fs.realpath(rawDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("resolveWorkingDirectory", () => {
    it("rejects relative paths", async () => {
      await expect(resolveWorkingDirectory("relative/path")).rejects.toThrow(
        "Working directory must be an absolute path"
      );
    });

    it("rejects missing directory", async () => {
      const missing = path.join(tempDir, "nonexistent");
      await expect(resolveWorkingDirectory(missing)).rejects.toThrow(
        "Working directory does not exist"
      );
    });

    it("rejects file path", async () => {
      const filePath = path.join(tempDir, "file.txt");
      await fs.writeFile(filePath, "content");
      await expect(resolveWorkingDirectory(filePath)).rejects.toThrow(
        "Working directory is not a directory"
      );
    });

    it("rejects filesystem root", async () => {
      await expect(resolveWorkingDirectory("/")).rejects.toThrow(
        "Working directory cannot be the filesystem root"
      );
    });

    it("rejects paths that resolve to filesystem root", async () => {
      await expect(
        resolveWorkingDirectory("/private/var/../..")
      ).rejects.toThrow("Working directory cannot be the filesystem root");
    });

    it("resolves symlinks to real directory", async () => {
      const realDir = path.join(tempDir, "real");
      const symlinkDir = path.join(tempDir, "symlink");
      await fs.mkdir(realDir);
      await fs.symlink(realDir, symlinkDir);

      const resolved = await resolveWorkingDirectory(symlinkDir);
      expect(resolved).toBe(realDir);
    });

    it("accepts valid directory", async () => {
      const resolved = await resolveWorkingDirectory(tempDir);
      expect(resolved).toBe(tempDir);
    });
  });

  describe("captureWorkspaceSnapshot", () => {
    it("returns non_git for non-git directory", async () => {
      const snapshot = await captureWorkspaceSnapshot(tempDir);
      expect(snapshot.kind).toBe("non_git");
      if (snapshot.kind === "non_git") {
        expect(snapshot.note).toContain("not inside a Git repository");
      }
    });

    it("captures git repository state", async () => {
      // Initialize a git repo
      const { execSync } = await import("node:child_process");
      execSync("git init", { cwd: tempDir });
      execSync("git config user.email test@test.com", { cwd: tempDir });
      execSync("git config user.name Test", { cwd: tempDir });

      // Create and commit a file
      await fs.writeFile(path.join(tempDir, "test.txt"), "initial");
      execSync("git add test.txt", { cwd: tempDir });
      execSync("git commit -m initial", { cwd: tempDir });

      // Create an untracked file
      await fs.writeFile(path.join(tempDir, "untracked.txt"), "new");

      const snapshot = await captureWorkspaceSnapshot(tempDir);
      expect(snapshot.kind).toBe("git");
      if (snapshot.kind === "git") {
        expect(snapshot.repositoryRoot).toBeTruthy();
        expect(snapshot.statusShort).toContain("untracked.txt");
      }
    });

    it("captures unstaged changes", async () => {
      const { execSync } = await import("node:child_process");
      execSync("git init", { cwd: tempDir });
      execSync("git config user.email test@test.com", { cwd: tempDir });
      execSync("git config user.name Test", { cwd: tempDir });

      await fs.writeFile(path.join(tempDir, "test.txt"), "initial");
      execSync("git add test.txt", { cwd: tempDir });
      execSync("git commit -m initial", { cwd: tempDir });

      // Modify file without staging
      await fs.writeFile(path.join(tempDir, "test.txt"), "modified");

      const snapshot = await captureWorkspaceSnapshot(tempDir);
      expect(snapshot.kind).toBe("git");
      if (snapshot.kind === "git") {
        expect(snapshot.unstagedDiffStat).toContain("test.txt");
      }
    });

    it("captures staged changes", async () => {
      const { execSync } = await import("node:child_process");
      execSync("git init", { cwd: tempDir });
      execSync("git config user.email test@test.com", { cwd: tempDir });
      execSync("git config user.name Test", { cwd: tempDir });

      await fs.writeFile(path.join(tempDir, "test.txt"), "initial");
      execSync("git add test.txt", { cwd: tempDir });
      execSync("git commit -m initial", { cwd: tempDir });

      // Modify and stage file
      await fs.writeFile(path.join(tempDir, "test.txt"), "staged");
      execSync("git add test.txt", { cwd: tempDir });

      const snapshot = await captureWorkspaceSnapshot(tempDir);
      expect(snapshot.kind).toBe("git");
      if (snapshot.kind === "git") {
        expect(snapshot.stagedDiffStat).toContain("test.txt");
      }
    });

    it("preserves existing uncommitted changes", async () => {
      const { execSync } = await import("node:child_process");
      execSync("git init", { cwd: tempDir });
      execSync("git config user.email test@test.com", { cwd: tempDir });
      execSync("git config user.name Test", { cwd: tempDir });

      await fs.writeFile(path.join(tempDir, "test.txt"), "initial");
      execSync("git add test.txt", { cwd: tempDir });
      execSync("git commit -m initial", { cwd: tempDir });

      // Create uncommitted changes
      await fs.writeFile(path.join(tempDir, "test.txt"), "modified");

      // Capture snapshot - should not modify the file
      await captureWorkspaceSnapshot(tempDir);

      const content = await fs.readFile(
        path.join(tempDir, "test.txt"),
        "utf-8"
      );
      expect(content).toBe("modified");
    });
  });
});
