import { describe, expect, it } from "vite-plus/test";

import { createAssignmentKey } from "./lib/worktree.ts";
import {
  buildGhosttyLaunchCommand,
  createManagedClassName,
  parseCliArgs,
  quoteShellArg,
  resolveStateFilePath,
} from "./ghostty-worktree.ts";

describe("ghostty-worktree", () => {
  it("creates a stable, worktree-specific class", () => {
    const key = createAssignmentKey("/repo/.git", "/repo-wt");
    expect(createManagedClassName(key)).toMatch(/^dev\.t3tools\.t3code\.ghostty\.w[0-9a-f]{12}$/u);
  });

  it("resolves state under XDG_STATE_HOME", () => {
    expect(resolveStateFilePath({ XDG_STATE_HOME: "/state" }, "/home/test")).toBe(
      "/state/ghostty-worktree/assignments.json",
    );
  });

  it("builds a Wayland Ghostty command with an exec payload", () => {
    const command = buildGhosttyLaunchCommand({
      className: "dev.t3tools.t3code.ghostty.wabc",
      cwd: "/repo/that's-fine",
      title: "Ghostty repo:feature",
      execCommand: "exec tmux",
    });
    expect(command).toContain("--gtk-single-instance=false");
    expect(command).toContain(quoteShellArg("/repo/that's-fine"));
    expect(command).toContain(quoteShellArg("exec tmux"));
  });

  it("accepts only open, list, and exec modes", () => {
    expect(parseCliArgs([])).toEqual({ mode: "open", execCommand: null });
    expect(parseCliArgs(["list-open"])).toEqual({ mode: "list-open", execCommand: null });
    expect(parseCliArgs(["--exec", "exec tmux"])).toEqual({
      mode: "open",
      execCommand: "exec tmux",
    });
    expect(() => parseCliArgs(["bad"])).toThrow("only accepts");
  });
});
