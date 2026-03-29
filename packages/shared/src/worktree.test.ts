import { describe, expect, it } from "vitest";

import { formatWorktreePathForDisplay, normalizeWorktreePath } from "./worktree";

describe("normalizeWorktreePath", () => {
  it("trims non-empty worktree paths", () => {
    expect(normalizeWorktreePath("  /tmp/project-worktree  ")).toBe("/tmp/project-worktree");
  });

  it("returns null for missing or blank values", () => {
    expect(normalizeWorktreePath(null)).toBeNull();
    expect(normalizeWorktreePath("")).toBeNull();
    expect(normalizeWorktreePath("   ")).toBeNull();
  });
});

describe("formatWorktreePathForDisplay", () => {
  it("uses the final path segment for unix-style paths", () => {
    expect(formatWorktreePathForDisplay("/tmp/project/feature-branch/")).toBe("feature-branch");
  });

  it("normalizes windows separators before picking the final segment", () => {
    expect(formatWorktreePathForDisplay("C:\\repo\\feature-branch\\")).toBe("feature-branch");
  });

  it("preserves root-like paths when no final segment exists", () => {
    expect(formatWorktreePathForDisplay("/")).toBe("/");
  });

  it("returns the original value for blank input", () => {
    expect(formatWorktreePathForDisplay("   ")).toBe("   ");
  });
});
