import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const MARKETPLACE_ROOT = path.resolve(PROJECT_ROOT, "..", "..");

describe("plugin structure", () => {
  it("plugin.json is valid JSON", () => {
    const pluginPath = path.join(PROJECT_ROOT, ".codex-plugin", "plugin.json");
    const content = fs.readFileSync(pluginPath, "utf-8");
    const manifest = JSON.parse(content);
    expect(manifest).toBeTruthy();
  });

  it("plugin name is codex-claude-executor", () => {
    const pluginPath = path.join(PROJECT_ROOT, ".codex-plugin", "plugin.json");
    const manifest = JSON.parse(fs.readFileSync(pluginPath, "utf-8"));
    expect(manifest.name).toBe("codex-claude-executor");
  });

  it("manifest references existing skills directory", () => {
    const pluginPath = path.join(PROJECT_ROOT, ".codex-plugin", "plugin.json");
    const manifest = JSON.parse(fs.readFileSync(pluginPath, "utf-8"));
    const skillsPath = path.resolve(PROJECT_ROOT, manifest.skills);
    expect(fs.existsSync(skillsPath)).toBe(true);
    expect(fs.statSync(skillsPath).isDirectory()).toBe(true);
  });

  it("manifest references existing .mcp.json", () => {
    const pluginPath = path.join(PROJECT_ROOT, ".codex-plugin", "plugin.json");
    const manifest = JSON.parse(fs.readFileSync(pluginPath, "utf-8"));
    const mcpPath = path.resolve(PROJECT_ROOT, manifest.mcpServers);
    expect(fs.existsSync(mcpPath)).toBe(true);
  });

  it(".mcp.json references ./dist/mcp-server.mjs", () => {
    const mcpPath = path.join(PROJECT_ROOT, ".mcp.json");
    const mcpConfig = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
    expect(mcpConfig.mcpServers).toBeTruthy();
    expect(mcpConfig.mcpServers["claude-executor"]).toBeTruthy();
    expect(mcpConfig.mcpServers["claude-executor"].args).toContain(
      "./dist/mcp-server.mjs"
    );
  });

  it("dist/mcp-server.mjs exists after bundling", () => {
    const bundlePath = path.join(PROJECT_ROOT, "dist", "mcp-server.mjs");
    expect(fs.existsSync(bundlePath)).toBe(true);
  });

  it("dist/job-worker.mjs exists after bundling", () => {
    const bundlePath = path.join(PROJECT_ROOT, "dist", "job-worker.mjs");
    expect(fs.existsSync(bundlePath)).toBe(true);
  });

  it("skill frontmatter contains required name and description", () => {
    const skillPath = path.join(
      PROJECT_ROOT,
      "skills",
      "plan-and-execute",
      "SKILL.md"
    );
    const content = fs.readFileSync(skillPath, "utf-8");

    // Check for frontmatter
    expect(content).toMatch(/^---\n/);
    expect(content).toContain("name: plan-and-execute");
    expect(content).toContain("description:");
  });

  it("documents Claude-owned edits and the user decision gate after interruption", () => {
    const skillPath = path.join(
      PROJECT_ROOT,
      "skills",
      "plan-and-execute",
      "SKILL.md"
    );
    const content = fs.readFileSync(skillPath, "utf-8");

    expect(content).toContain(
      "If Codex verification fails, create a focused repair plan and delegate it to Claude. Codex must not directly patch the code."
    );
    expect(content).toContain(
      "Ask the user whether to continue waiting, investigate the cause, retry Claude, or explicitly authorize Codex to take over."
    );
    expect(content).toContain(
      'While a `claude_write_only` job for a workspace remains `running`, `restarting`, or `cancelling`, Codex must not edit files in that workspace'
    );
    expect(content).toContain(
      "Use `start_execution` by default for implementation and repair runs"
    );
    expect(content).toContain(
      "Do not read logs on every loop just because they are available."
    );
    expect(content).toContain(
      "allow one sparse heartbeat about every 3 minutes"
    );
  });

  it("no production source file contains console.log", () => {
    const srcDir = path.join(PROJECT_ROOT, "src");
    const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"));

    for (const file of files) {
      const content = fs.readFileSync(path.join(srcDir, file), "utf-8");
      // Allow console.error but not console.log
      const logStatements = content.match(/console\.log\s*\(/g);
      expect(
        logStatements,
        `${file} contains console.log`
      ).toBeNull();
    }
  });

  it("documents marketplace-based plugin installation commands", () => {
    const readme = fs.readFileSync(path.join(PROJECT_ROOT, "README.md"), "utf-8");
    expect(readme).toContain("codex plugin marketplace add");
    expect(readme).toMatch(/codex plugin add codex-claude-executor@/);
    expect(readme).not.toContain("codex plugin add /path/to/codex-claude-executor");
    expect(readme).not.toContain("codex plugin disable");
  });

  it("is published by the repository marketplace", () => {
    const marketplacePath = path.join(
      MARKETPLACE_ROOT,
      ".agents",
      "plugins",
      "marketplace.json"
    );
    const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf-8"));
    const entry = marketplace.plugins.find(
      (plugin: { name: string }) => plugin.name === "codex-claude-executor"
    );

    expect(marketplace.name).toBe("crayonyyxm");
    expect(entry).toBeTruthy();
    expect(entry.source.path).toBe("./plugins/codex-claude-executor");
    expect(
      fs.existsSync(path.resolve(MARKETPLACE_ROOT, entry.source.path))
    ).toBe(true);
  });
});
