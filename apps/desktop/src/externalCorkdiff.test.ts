import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type * as ChildProcess from "node:child_process";

import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  ExternalCorkdiffManager,
  extractWorkspaceIdFromStdout,
  findHyprWorkspaceForPids,
} from "./externalCorkdiff";

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

  it("finds the current app workspace from Hypr clients", () => {
    const clients = [
      { pid: 999, workspace: { id: 4 } },
      { pid: 1234, workspace: { id: 11 } },
    ];

    expect(findHyprWorkspaceForPids(clients, [1234, 999])).toBe(11);
    expect(findHyprWorkspaceForPids(clients, [555])).toBeNull();
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
