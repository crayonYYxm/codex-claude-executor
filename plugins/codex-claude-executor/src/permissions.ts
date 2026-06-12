/**
 * Permissions module for controlling Claude Code tool access.
 *
 * Provides a fixed allowlist of safe tools and validation
 * for per-execution additional tool permissions.
 */

export const FIXED_ALLOWED_TOOLS: readonly string[] = [
  // File and search tools
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",

  // Safe Git inspection commands
  "Bash(git status)",
  "Bash(git status *)",
  "Bash(git diff)",
  "Bash(git diff *)",
  "Bash(git log)",
  "Bash(git log *)",
  "Bash(git rev-parse *)",

  // Common build and test commands - npm
  "Bash(npm test)",
  "Bash(npm test *)",
  "Bash(npm run test)",
  "Bash(npm run test *)",
  "Bash(npm run build)",
  "Bash(npm run build *)",

  // Common build and test commands - pnpm
  "Bash(pnpm test)",
  "Bash(pnpm test *)",
  "Bash(pnpm run test *)",
  "Bash(pnpm run build *)",

  // Common build and test commands - yarn
  "Bash(yarn test)",
  "Bash(yarn test *)",
  "Bash(yarn build)",
  "Bash(yarn build *)",

  // Python
  "Bash(pytest)",
  "Bash(pytest *)",
  "Bash(python -m pytest *)",

  // Rust
  "Bash(cargo test)",
  "Bash(cargo test *)",
  "Bash(cargo build)",
  "Bash(cargo build *)",

  // Go
  "Bash(go test *)",
  "Bash(go build *)",
] as const;

const MAX_EXTRA_TOOLS = 20;
const MAX_TOOL_LENGTH = 300;

/**
 * Validate and sanitize extra allowed tools for a single execution.
 *
 * Rules:
 * - Maximum 20 additional entries
 * - Trim whitespace
 * - Reject empty values
 * - Reject strings containing newlines or ASCII control characters
 * - Reject values longer than 300 characters
 * - Deduplicate while preserving order
 * - Do not store additional permissions globally or between calls
 */
export function validateExtraAllowedTools(tools: string[]): string[] {
  if (tools.length > MAX_EXTRA_TOOLS) {
    throw new Error(
      `Maximum ${MAX_EXTRA_TOOLS} additional tools allowed, got ${tools.length}`
    );
  }

  const seen = new Set<string>();
  const validated: string[] = [];

  for (const [index, tool] of tools.entries()) {
    const trimmed = tool.trim();

    // Reject empty values so execution never proceeds with fewer permissions
    // than the user explicitly confirmed.
    if (trimmed.length === 0) {
      throw new Error(`Additional tool at index ${index} cannot be empty`);
    }

    // Reject values containing newlines or ASCII control characters
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(trimmed)) {
      throw new Error(
        `Additional tool at index ${index} cannot contain control characters`
      );
    }

    // Reject values longer than 300 characters
    if (trimmed.length > MAX_TOOL_LENGTH) {
      throw new Error(
        `Additional tool at index ${index} cannot exceed ${MAX_TOOL_LENGTH} characters`
      );
    }

    // Deduplicate while preserving order
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      validated.push(trimmed);
    }
  }

  return validated;
}

/**
 * Merge fixed allowed tools with validated per-execution additional tools.
 *
 * Fixed tools always come first. Additional tools are validated and appended.
 * Duplicates between fixed and additional tools are removed.
 */
export function mergeAllowedTools(extraTools: string[]): string[] {
  const validated = validateExtraAllowedTools(extraTools);
  const fixedSet = new Set(FIXED_ALLOWED_TOOLS);

  // Filter out any extra tools that are already in the fixed set
  const uniqueExtras = validated.filter((tool) => !fixedSet.has(tool));

  return [...FIXED_ALLOWED_TOOLS, ...uniqueExtras];
}
