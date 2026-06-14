import { describe, it, expect } from "vitest";
import {
  FIXED_ALLOWED_TOOLS,
  validateExtraAllowedTools,
  mergeAllowedTools,
} from "../src/permissions.js";

describe("permissions", () => {
  describe("FIXED_ALLOWED_TOOLS", () => {
    it("contains expected file and search tools", () => {
      expect(FIXED_ALLOWED_TOOLS).toContain("Read");
      expect(FIXED_ALLOWED_TOOLS).toContain("Glob");
      expect(FIXED_ALLOWED_TOOLS).toContain("Grep");
      expect(FIXED_ALLOWED_TOOLS).toContain("Edit");
      expect(FIXED_ALLOWED_TOOLS).toContain("Write");
    });

    it("allows unrestricted Bash commands during delegated execution", () => {
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash");
    });

    it("contains safe git inspection commands", () => {
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(git status)");
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(git status *)");
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(git diff)");
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(git diff *)");
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(git log)");
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(git log *)");
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(git rev-parse *)");
    });

    it("contains common build, test, and lint commands", () => {
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(npm test)");
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(npm run build)");
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(npm run lint *)");
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(npm run typecheck)");
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(npm run verify)");
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(npm run check *)");
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(pnpm test)");
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(pnpm run lint)");
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(pnpm run verify)");
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(yarn build)");
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(yarn check *)");
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(pytest)");
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(cargo test)");
      expect(FIXED_ALLOWED_TOOLS).toContain("Bash(go test *)");
    });

    it("does not contain dangerous commands", () => {
      expect(FIXED_ALLOWED_TOOLS).not.toContain("Bash(rm -rf *)");
      expect(FIXED_ALLOWED_TOOLS).not.toContain("Bash(git push *)");
      expect(FIXED_ALLOWED_TOOLS).not.toContain("Bash(npx *)");
      expect(FIXED_ALLOWED_TOOLS).not.toContain("Bash(git commit *)");
    });
  });

  describe("validateExtraAllowedTools", () => {
    it("returns empty array for empty input", () => {
      expect(validateExtraAllowedTools([])).toEqual([]);
    });

    it("trims whitespace from entries", () => {
      const result = validateExtraAllowedTools(["  Bash(custom)  "]);
      expect(result).toEqual(["Bash(custom)"]);
    });

    it("rejects empty values", () => {
      expect(() =>
        validateExtraAllowedTools(["", "  ", "Bash(valid)"])
      ).toThrow("cannot be empty");
    });

    it("rejects values containing newlines", () => {
      expect(() =>
        validateExtraAllowedTools(["Bash(valid)\nBash(bad)"])
      ).toThrow("control characters");
    });

    it("rejects values containing control characters", () => {
      expect(() => validateExtraAllowedTools(["Bash(valid)\x00"])).toThrow(
        "control characters"
      );
    });

    it("rejects values longer than 300 characters", () => {
      const longValue = "Bash(" + "a".repeat(300) + ")";
      expect(() => validateExtraAllowedTools([longValue])).toThrow(
        "300 characters"
      );
    });

    it("deduplicates while preserving order", () => {
      const result = validateExtraAllowedTools([
        "Bash(first)",
        "Bash(second)",
        "Bash(first)",
        "Bash(third)",
      ]);
      expect(result).toEqual(["Bash(first)", "Bash(second)", "Bash(third)"]);
    });

    it("rejects more than 20 entries", () => {
      const entries = Array.from({ length: 21 }, (_, i) => `Bash(cmd${i})`);
      expect(() => validateExtraAllowedTools(entries)).toThrow(
        "Maximum 20 additional tools allowed"
      );
    });

    it("accepts up to 20 entries", () => {
      const entries = Array.from({ length: 20 }, (_, i) => `Bash(cmd${i})`);
      const result = validateExtraAllowedTools(entries);
      expect(result).toHaveLength(20);
    });
  });

  describe("mergeAllowedTools", () => {
    it("returns only fixed tools when no extras provided", () => {
      const result = mergeAllowedTools([]);
      expect(result).toEqual(FIXED_ALLOWED_TOOLS);
    });

    it("appends additional tools after fixed tools", () => {
      const result = mergeAllowedTools(["Bash(custom1)", "Bash(custom2)"]);
      const fixedCount = FIXED_ALLOWED_TOOLS.length;
      expect(result).toHaveLength(fixedCount + 2);
      expect(result[fixedCount]).toBe("Bash(custom1)");
      expect(result[fixedCount + 1]).toBe("Bash(custom2)");
    });

    it("fixed tools are always first", () => {
      const result = mergeAllowedTools(["Read", "Bash(custom)"]);
      // "Read" is a fixed tool, should not be duplicated
      const firstReadIndex = result.indexOf("Read");
      expect(firstReadIndex).toBeLessThan(FIXED_ALLOWED_TOOLS.length);
    });

    it("removes duplicates between fixed and extra tools", () => {
      const result = mergeAllowedTools(["Read", "Bash(git status)"]);
      // These are fixed tools, should not appear twice
      const readCount = result.filter((t) => t === "Read").length;
      expect(readCount).toBe(1);
    });

    it("additional permissions do not persist between calls", () => {
      mergeAllowedTools(["Bash(temporary)"]);
      const result = mergeAllowedTools([]);
      expect(result).not.toContain("Bash(temporary)");
    });
  });
});
