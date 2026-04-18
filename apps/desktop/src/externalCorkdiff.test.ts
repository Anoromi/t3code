import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type * as ChildProcess from "node:child_process";

import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  ExternalCorkdiffManager,
  buildCorkdiffGhosttyArgs,
  buildCorkdiffHyprctlExecCommand,
  createCorkdiffGhosttyClassName,
  extractWorkspaceIdForHyprnavSpawnSocketFallback,
  extractWorkspaceIdFromStdout,
  findHyprWorkspaceForClassName,
  findHyprWorkspaceForPids,
} from "./externalCorkdiff.js";

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

function spawnSyncResult(stdout = ""): ChildProcess.SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status: 0,
    signal: null,
  };
}

describe("externalCorkdiff helpers", () => {
  it("parses the first non-empty workspace id line", () => {
    expect(extractWorkspaceIdFromStdout("\n101\n")).toBe(101);
    expect(extractWorkspaceIdFromStdout("workspace\n101\n")).toBeNull();
    expect(extractWorkspaceIdFromStdout("")).toBeNull();
  });

  it("detects hyprnav spawn socket failures that can fall back to hyprctl exec", () => {
    expect(
      extractWorkspaceIdForHyprnavSpawnSocketFallback({
        stdout: "104\n",
        stderr: "Error: request_failed: connecting to /run/user/1000/hx/session/spawn.sock",
      }),
    ).toBe(104);
    expect(
      extractWorkspaceIdForHyprnavSpawnSocketFallback({
        stdout: "104\n",
        stderr: "hyprnav spawn failed",
      }),
    ).toBeNull();
    expect(
      extractWorkspaceIdForHyprnavSpawnSocketFallback({
        stdout: "",
        stderr: "Error: request_failed: connecting to /run/user/1000/hx/session/spawn.sock",
      }),
    ).toBeNull();
  });

  it("finds the current app workspace from Hypr clients", () => {
    const clients = [
      { pid: 999, workspace: { id: 4 } },
      { pid: 1234, workspace: { id: 11 } },
    ];

    expect(findHyprWorkspaceForPids(clients, [1234, 999])).toBe(11);
    expect(findHyprWorkspaceForPids(clients, [555])).toBeNull();
  });

  it("finds an external Corkdiff workspace by managed Ghostty class", () => {
    const className = createCorkdiffGhosttyClassName("thread-1");
    expect(
      findHyprWorkspaceForClassName(
        [
          { class: "other", workspace: { id: 4 } },
          { class: className, workspace: { id: 12 } },
        ],
        className,
      ),
    ).toBe(12);
  });

  it("builds a cwd-scoped hyprctl exec fallback command", () => {
    const className = createCorkdiffGhosttyClassName("thread-1");
    const command = buildCorkdiffHyprctlExecCommand({
      className,
      cwd: "/tmp/project with spaces",
      serverUrl: "ws://127.0.0.1:3773/ws",
      token: "secret",
      threadId: "thread-1",
    });

    expect(command).toContain("sh -lc");
    expect(command).toContain("/tmp/project with spaces");
    expect(command).toContain("ghostty");
    expect(command).toContain(className);
    expect(command).toContain("CorkDiff t3code thread-1");
  });

  it("passes Ghostty config arguments in key=value form", () => {
    const className = createCorkdiffGhosttyClassName("thread-1");
    expect(
      buildCorkdiffGhosttyArgs({
        className,
        serverUrl: "ws://127.0.0.1:3773/ws",
        token: null,
        threadId: "thread-1",
      }),
    ).toEqual(
      expect.arrayContaining([`--class=${className}`, "--title=T3 Code Corkdiff thread-1"]),
    );
  });
});

describe("ExternalCorkdiffManager", () => {
  it("reuses a live session for the same thread", async () => {
    const child = createChildProcess();
    const spawn = vi.fn(() => child);
    const spawnSync = vi.fn(() => spawnSyncResult());
    const show = vi.fn();
    const focus = vi.fn();
    const manager = new ExternalCorkdiffManager({
      spawn: spawn as typeof ChildProcess.spawn,
      spawnSync: spawnSync as unknown as typeof ChildProcess.spawnSync,
      now: () => 1,
      getMainWindow: () =>
        ({
          show,
          focus,
          webContents: { getOSProcessId: () => 1234 },
        }) as unknown as BrowserWindow,
    });

    const firstTogglePromise = manager.toggle({
      cwd: "/tmp/project",
      serverUrl: "ws://127.0.0.1:3773/ws",
      token: "secret",
      threadId: "thread-1",
    });

    (child.stdout as PassThrough).write("101\n");
    await expect(firstTogglePromise).resolves.toEqual({ workspaceId: 101, reused: false });

    await expect(
      manager.toggle({
        cwd: "/tmp/project",
        serverUrl: "ws://127.0.0.1:3773/ws",
        token: "secret",
        threadId: "thread-1",
      }),
    ).resolves.toEqual({ workspaceId: 101, reused: true });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith(
      "hyprctl",
      ["dispatch", "workspace", "101"],
      expect.any(Object),
    );
    expect(show).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it("falls back to hyprctl exec when hyprnav reports a spawn socket failure", async () => {
    const child = createChildProcess();
    const spawn = vi.fn(() => child);
    const spawnSync = vi.fn(() => spawnSyncResult());
    const manager = new ExternalCorkdiffManager({
      spawn: spawn as typeof ChildProcess.spawn,
      spawnSync: spawnSync as unknown as typeof ChildProcess.spawnSync,
      now: () => 1,
      getMainWindow: () => null,
    });

    const togglePromise = manager.toggle({
      cwd: "/tmp/project",
      serverUrl: "ws://127.0.0.1:3773/ws",
      token: "secret",
      threadId: "thread-1",
    });

    (child.stdout as PassThrough).write("104\n");
    (child.stderr as PassThrough).write(
      "Error: request_failed: connecting to /run/user/1000/hx/session/spawn.sock",
    );
    child.emit("exit", 1, null);

    await expect(togglePromise).resolves.toEqual({ workspaceId: 104, reused: false });
    expect(spawnSync).toHaveBeenCalledWith(
      "hyprctl",
      ["dispatch", "workspace", "104"],
      expect.any(Object),
    );
    expect(spawnSync).toHaveBeenCalledWith(
      "hyprctl",
      ["dispatch", "exec", expect.stringContaining("CorkDiff t3code thread-1")],
      expect.any(Object),
    );
  });

  it("focuses the current app workspace before focusing the window", () => {
    const spawnSync = vi.fn((command: string, args: readonly string[]) => {
      if (command === "hyprctl" && args[0] === "-j") {
        return spawnSyncResult(JSON.stringify([{ pid: 1234, workspace: { id: 7 } }]));
      }
      return spawnSyncResult();
    });
    const show = vi.fn();
    const focus = vi.fn();
    const manager = new ExternalCorkdiffManager({
      spawn: vi.fn() as typeof ChildProcess.spawn,
      spawnSync: spawnSync as unknown as typeof ChildProcess.spawnSync,
      now: () => 1,
      getMainWindow: () =>
        ({
          show,
          focus,
          webContents: { getOSProcessId: () => 1234 },
        }) as unknown as BrowserWindow,
    });

    manager.focusAppWindow();

    expect(spawnSync).toHaveBeenCalledWith(
      "hyprctl",
      ["dispatch", "workspace", "7"],
      expect.any(Object),
    );
    expect(show).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });
});
