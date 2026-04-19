import type * as ChildProcess from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  buildEditorCommand,
  buildWorktreeTerminalCommand,
  createHyprnavEnvironmentSync,
  normalizeClearSlots,
} from "./hyprnav.js";

function spawnSyncResult(
  overrides: Partial<ChildProcess.SpawnSyncReturns<string>> = {},
): ChildProcess.SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    ...overrides,
  };
}

function getSpawnSyncArgs(call: readonly unknown[]): readonly string[] | null {
  const args = call[1];
  return Array.isArray(args) && args.every((arg) => typeof arg === "string") ? args : null;
}

describe("hyprnav helpers", () => {
  it("deduplicates and filters clearSlots", () => {
    expect(normalizeClearSlots([4, 0, 2, 4, -1, 2])).toEqual([2, 4]);
    expect(normalizeClearSlots(undefined)).toEqual([]);
  });

  it("builds hidden commands for special actions", () => {
    expect(
      buildWorktreeTerminalCommand({
        environmentPath: "/repo/worktrees/feature-a",
      }),
    ).toBe(
      "exec ghostty --gtk-single-instance=false --working-directory='/repo/worktrees/feature-a' -e sh -lc 'exec tmux'",
    );
    expect(
      buildEditorCommand({
        environmentPath: "/repo/worktrees/feature-a",
        preferredEditor: "cursor",
      }),
    ).toBe("'cursor' '/repo/worktrees/feature-a'");
  });
});

describe("HyprnavEnvironmentSync", () => {
  it("locks the canonical environment without syncing slots", async () => {
    const spawnSync = vi.fn(() => spawnSyncResult());
    const sync = createHyprnavEnvironmentSync({
      spawnSync: spawnSync as unknown as typeof ChildProcess.spawnSync,
      resolvePath: (value: string) => `/resolved${value}`,
      realpathSync: (value: string) => `/real${value}`,
    });

    await expect(
      sync.lockEnvironment({ environmentPath: "/repo/worktrees/feature-a" }),
    ).resolves.toEqual({ status: "ok", message: null });

    expect(spawnSync.mock.calls).toEqual([
      ["hyprnav", ["lock", "/real/resolved/repo/worktrees/feature-a"], expect.any(Object)],
    ]);
  });

  it("returns unavailable when lock-only hyprnav is missing", async () => {
    const spawnSync = vi.fn(() =>
      spawnSyncResult({ error: Object.assign(new Error("missing"), { code: "ENOENT" }) }),
    );
    const sync = createHyprnavEnvironmentSync({
      spawnSync: spawnSync as unknown as typeof ChildProcess.spawnSync,
      resolvePath: (value: string) => value,
      realpathSync: (value: string) => value,
    });

    await expect(sync.lockEnvironment({ environmentPath: "/repo" })).resolves.toEqual({
      status: "unavailable",
      message: "hyprnav is not installed or not available in PATH.",
    });
  });

  it("coalesces rapid lock-only requests for the same environment", async () => {
    const spawnSync = vi.fn(() => spawnSyncResult());
    const sync = createHyprnavEnvironmentSync({
      spawnSync: spawnSync as unknown as typeof ChildProcess.spawnSync,
      resolvePath: (value: string) => value,
      realpathSync: (value: string) => value,
    });

    await expect(
      Promise.all([
        sync.lockEnvironment({ environmentPath: "/repo" }),
        sync.lockEnvironment({ environmentPath: "/repo" }),
      ]),
    ).resolves.toEqual([
      { status: "ok", message: null },
      { status: "ok", message: null },
    ]);

    expect(spawnSync.mock.calls).toEqual([["hyprnav", ["lock", "/repo"], expect.any(Object)]]);
  });

  it("ensures, clears, assigns, stores typed action commands, and locks the canonical environment", async () => {
    const spawnSync = vi.fn(() => spawnSyncResult());
    const sync = createHyprnavEnvironmentSync({
      spawnSync: spawnSync as unknown as typeof ChildProcess.spawnSync,
      resolvePath: (value: string) => `/resolved${value}`,
      realpathSync: (value: string) => `/real${value}`,
    });

    await expect(
      sync.sync({
        environmentPath: "/repo/worktrees/feature-a",
        projectRoot: "/repo",
        preferredEditor: "cursor",
        hyprnav: {
          bindings: [
            { id: "terminal", slot: 1, action: "worktree-terminal" },
            { id: "editor", slot: 2, action: "open-favorite-editor" },
            { id: "custom", slot: 5, action: "shell-command", command: "echo hi" },
          ],
        },
        clearSlots: [7],
        lock: true,
      }),
    ).resolves.toEqual({ status: "ok", message: null });

    expect(spawnSync.mock.calls).toEqual([
      [
        "hyprnav",
        ["env", "ensure", "--cwd", "/real/resolved/repo/worktrees/feature-a", "--client", "t3code"],
        expect.any(Object),
      ],
      [
        "hyprnav",
        [
          "slot",
          "command",
          "clear",
          "--env",
          "/real/resolved/repo/worktrees/feature-a",
          "--slot",
          "7",
        ],
        expect.any(Object),
      ],
      [
        "hyprnav",
        ["slot", "clear", "--env", "/real/resolved/repo/worktrees/feature-a", "--slot", "7"],
        expect.any(Object),
      ],
      [
        "hyprnav",
        [
          "slot",
          "assign",
          "--cwd",
          "/real/resolved/repo/worktrees/feature-a",
          "--slot",
          "1",
          "--managed",
          "--client",
          "t3code",
        ],
        expect.any(Object),
      ],
      [
        "hyprnav",
        [
          "slot",
          "command",
          "set",
          "--env",
          "/real/resolved/repo/worktrees/feature-a",
          "--slot",
          "1",
          "--",
          "sh",
          "-lc",
          "exec ghostty --gtk-single-instance=false --working-directory='/real/resolved/repo/worktrees/feature-a' -e sh -lc 'exec tmux'",
        ],
        expect.any(Object),
      ],
      [
        "hyprnav",
        [
          "slot",
          "assign",
          "--cwd",
          "/real/resolved/repo/worktrees/feature-a",
          "--slot",
          "2",
          "--managed",
          "--client",
          "t3code",
        ],
        expect.any(Object),
      ],
      [
        "hyprnav",
        [
          "slot",
          "command",
          "set",
          "--env",
          "/real/resolved/repo/worktrees/feature-a",
          "--slot",
          "2",
          "--",
          "sh",
          "-lc",
          "'cursor' '/real/resolved/repo/worktrees/feature-a'",
        ],
        expect.any(Object),
      ],
      [
        "hyprnav",
        [
          "slot",
          "assign",
          "--cwd",
          "/real/resolved/repo/worktrees/feature-a",
          "--slot",
          "5",
          "--managed",
          "--client",
          "t3code",
        ],
        expect.any(Object),
      ],
      [
        "hyprnav",
        [
          "slot",
          "command",
          "set",
          "--env",
          "/real/resolved/repo/worktrees/feature-a",
          "--slot",
          "5",
          "--",
          "sh",
          "-lc",
          "echo hi",
        ],
        expect.any(Object),
      ],
      ["hyprnav", ["lock", "/real/resolved/repo/worktrees/feature-a"], expect.any(Object)],
    ]);
  });

  it("returns unavailable when hyprnav is missing", async () => {
    const spawnSync = vi.fn(() =>
      spawnSyncResult({ error: Object.assign(new Error("missing"), { code: "ENOENT" }) }),
    );
    const sync = createHyprnavEnvironmentSync({
      spawnSync: spawnSync as unknown as typeof ChildProcess.spawnSync,
      resolvePath: (value: string) => value,
      realpathSync: (value: string) => value,
    });

    await expect(
      sync.sync({
        environmentPath: "/repo",
        projectRoot: "/repo",
        hyprnav: {
          bindings: [{ id: "custom", slot: 3, action: "shell-command", command: "echo hi" }],
        },
        lock: false,
      }),
    ).resolves.toEqual({
      status: "unavailable",
      message: "hyprnav is not installed or not available in PATH.",
    });
  });

  it("returns unavailable when favorite editor action has no editor", async () => {
    const spawnSync = vi.fn(() => spawnSyncResult());
    const sync = createHyprnavEnvironmentSync({
      spawnSync: spawnSync as unknown as typeof ChildProcess.spawnSync,
      resolvePath: (value: string) => value,
      realpathSync: (value: string) => value,
    });

    await expect(
      sync.sync({
        environmentPath: "/repo",
        projectRoot: "/repo",
        hyprnav: {
          bindings: [{ id: "editor", slot: 2, action: "open-favorite-editor" }],
        },
        lock: false,
      }),
    ).resolves.toEqual({
      status: "unavailable",
      message: "No available favorite editor is configured.",
    });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("coalesces rapid requests for the same environment", async () => {
    let callCount = 0;
    const spawnSync = vi.fn(() => {
      callCount += 1;
      return spawnSyncResult();
    });
    const sync = createHyprnavEnvironmentSync({
      spawnSync: spawnSync as unknown as typeof ChildProcess.spawnSync,
      resolvePath: (value: string) => value,
      realpathSync: (value: string) => value,
    });

    const first = sync.sync({
      environmentPath: "/repo",
      projectRoot: "/repo",
      hyprnav: {
        bindings: [{ id: "first", slot: 1, action: "shell-command", command: "one" }],
      },
      clearSlots: [7],
      lock: false,
    });
    const second = sync.sync({
      environmentPath: "/repo",
      projectRoot: "/repo",
      hyprnav: {
        bindings: [{ id: "second", slot: 3, action: "shell-command", command: "two" }],
      },
      clearSlots: [8],
      lock: true,
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "ok", message: null },
      { status: "ok", message: null },
    ]);
    expect(callCount).toBeGreaterThan(0);
    expect(
      spawnSync.mock.calls.some((call) => {
        const args = getSpawnSyncArgs(call);
        return args?.[0] === "lock" && args[1] === "/repo";
      }),
    ).toBe(true);
    expect(
      spawnSync.mock.calls.some((call) => {
        const args = getSpawnSyncArgs(call);
        return args?.[0] === "slot" && args[1] === "clear" && args[5] === "7";
      }),
    ).toBe(true);
    expect(
      spawnSync.mock.calls.some((call) => {
        const args = getSpawnSyncArgs(call);
        return args?.[0] === "slot" && args[1] === "clear" && args[5] === "8";
      }),
    ).toBe(true);
  });
});
