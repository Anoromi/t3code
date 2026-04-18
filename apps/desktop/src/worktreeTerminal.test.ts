import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type * as ChildProcess from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  extractWorktreePathFromStdout,
  parseOpenWorktreeTerminalEntries,
  WorktreeTerminalLauncher,
} from "./worktreeTerminal.js";

function createChildProcess(): ChildProcess.ChildProcess {
  const child = new EventEmitter() as ChildProcess.ChildProcess & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: null;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = null;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  return child;
}

describe("worktreeTerminal helpers", () => {
  it("parses the first non-empty worktree assignment line", () => {
    expect(extractWorktreePathFromStdout("\npid=101 workspace=1 worktree=/tmp/worktree\n")).toBe(
      "/tmp/worktree",
    );
    expect(
      extractWorktreePathFromStdout("workspace\npid=101 workspace=1 worktree=/tmp/worktree"),
    ).toBeNull();
    expect(extractWorktreePathFromStdout("")).toBeNull();
  });

  it("parses open worktree terminal list JSON", () => {
    expect(
      parseOpenWorktreeTerminalEntries(
        JSON.stringify([{ worktreePath: "/tmp/project/worktrees/feature-a" }]),
      ),
    ).toEqual([{ worktreePath: "/tmp/project/worktrees/feature-a" }]);
  });

  it("rejects malformed open worktree terminal list JSON", () => {
    expect(() => parseOpenWorktreeTerminalEntries("{bad-json")).toThrow(
      "Malformed open worktree terminal list JSON",
    );
  });
});

describe("WorktreeTerminalLauncher", () => {
  it("spawns ghostty-worktree through bun with tmux exec payload", async () => {
    const child = createChildProcess();
    const spawn = vi.fn(() => child);
    const launcher = new WorktreeTerminalLauncher({
      spawn: spawn as typeof ChildProcess.spawn,
    });

    const openPromise = launcher.open({
      cwd: "/tmp/project/worktrees/feature-a",
      rootDir: "/repo",
    });

    (child.stdout as PassThrough).write(
      "pid=100 workspace=1 worktree=/tmp/project/worktrees/feature-a\n",
    );
    await expect(openPromise).resolves.toEqual({
      worktreePath: "/tmp/project/worktrees/feature-a",
    });

    expect(spawn).toHaveBeenCalledWith(
      "bun",
      ["/repo/scripts/ghostty-worktree.ts", "--exec", "exec tmux"],
      expect.objectContaining({
        cwd: "/tmp/project/worktrees/feature-a",
      }),
    );
  });

  it("lists open worktree terminals through the script query", async () => {
    const child = createChildProcess();
    const spawn = vi.fn(() => child);
    const launcher = new WorktreeTerminalLauncher({
      spawn: spawn as typeof ChildProcess.spawn,
    });

    const listPromise = launcher.listOpen({
      rootDir: "/repo",
    });

    (child.stdout as PassThrough).write(
      JSON.stringify([{ worktreePath: "/tmp/project/worktrees/feature-a" }]),
    );
    child.emit("exit", 0, null);

    await expect(listPromise).resolves.toEqual([
      { worktreePath: "/tmp/project/worktrees/feature-a" },
    ]);
    expect(spawn).toHaveBeenCalledWith(
      "bun",
      ["/repo/scripts/ghostty-worktree.ts", "list-open"],
      expect.objectContaining({
        cwd: "/repo",
      }),
    );
  });

  it("rejects invalid cwd values", async () => {
    const launcher = new WorktreeTerminalLauncher({
      spawn: vi.fn() as typeof ChildProcess.spawn,
    });

    await expect(
      launcher.open({
        cwd: "   ",
        rootDir: "/repo",
      }),
    ).rejects.toThrow("Worktree terminal launch requires a valid working directory.");
  });

  it("propagates launcher stderr on failure", async () => {
    const child = createChildProcess();
    const launcher = new WorktreeTerminalLauncher({
      spawn: vi.fn(() => child) as typeof ChildProcess.spawn,
    });

    const openPromise = launcher.open({
      cwd: "/tmp/project/worktrees/feature-a",
      rootDir: "/repo",
    });

    (child.stderr as PassThrough).write(
      "[ghostty-worktree] Ghostty does not appear to be installed in PATH.\n",
    );
    child.emit("exit", 1, null);

    await expect(openPromise).rejects.toThrow("Ghostty does not appear to be installed in PATH.");
  });

  it("rejects malformed stdout when the launcher exits cleanly", async () => {
    const child = createChildProcess();
    const launcher = new WorktreeTerminalLauncher({
      spawn: vi.fn(() => child) as typeof ChildProcess.spawn,
    });

    const openPromise = launcher.open({
      cwd: "/tmp/project/worktrees/feature-a",
      rootDir: "/repo",
    });

    (child.stdout as PassThrough).write("not-a-managed-assignment\n");
    child.emit("exit", 0, null);

    await expect(openPromise).rejects.toThrow(
      "Worktree terminal launcher exited before launch completed: launcher exited with code 0",
    );
  });
});
