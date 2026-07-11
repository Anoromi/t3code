// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeChildProcess from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  extractWorktreePathFromStdout,
  parseOpenWorktreeTerminalEntries,
  WorktreeTerminalLauncher,
} from "./WorktreeTerminal.ts";

class Stream extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

function child() {
  const value = new EventEmitter() as EventEmitter & {
    stdout: Stream;
    stderr: Stream;
    stdin: null;
  };
  value.stdout = new Stream();
  value.stderr = new Stream();
  value.stdin = null;
  return value;
}

describe("WorktreeTerminalLauncher", () => {
  it("parses launcher output", () => {
    expect(extractWorktreePathFromStdout("pid=1 workspace=4 worktree=/repo/wt/a\n")).toBe(
      "/repo/wt/a",
    );
    expect(parseOpenWorktreeTerminalEntries('[{"worktreePath":"/repo/wt/a"}]')).toEqual([
      { worktreePath: "/repo/wt/a" },
    ]);
  });

  it("opens through the Wayland Ghostty worktree script", async () => {
    const process = child();
    const spawn = vi.fn(() => process as unknown as NodeChildProcess.ChildProcess);
    const launcher = new WorktreeTerminalLauncher({
      spawn: spawn as typeof NodeChildProcess.spawn,
      runtimeExecutable: "/opt/t3code/electron",
      runtimeEnv: { WAYLAND_DISPLAY: "wayland-1" },
    });
    const result = launcher.open({
      cwd: "/repo/wt/a",
      scriptPath: "/opt/t3code/resources/ghostty-worktree.cjs",
    });
    process.stdout.emit("data", "pid=1 workspace=4 worktree=/repo/wt/a\n");
    await expect(result).resolves.toEqual({ worktreePath: "/repo/wt/a" });
    expect(spawn).toHaveBeenCalledWith(
      "/opt/t3code/electron",
      ["/opt/t3code/resources/ghostty-worktree.cjs", "--exec", "exec tmux"],
      expect.objectContaining({
        env: { WAYLAND_DISPLAY: "wayland-1", ELECTRON_RUN_AS_NODE: "1" },
      }),
    );
  });
});
