import type * as ChildProcess from "node:child_process";

import { DEFAULT_PROJECT_HYPRNAV_WORKSPACE_TARGET } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  buildEditorCommand,
  buildHyprnavEnvironmentIds,
  buildWorktreeTerminalCommand,
  createHyprnavEnvironmentSync,
  expandHyprnavCommandTemplate,
  normalizeClearBindings,
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
  it("deduplicates and filters clear bindings", () => {
    expect(
      normalizeClearBindings([
        { scope: "worktree", slot: 4 },
        { scope: "worktree", slot: 4 },
        { scope: "project", slot: 2 },
        { scope: "thread", slot: -1 },
      ] as never),
    ).toEqual([
      { scope: "project", slot: 2 },
      { scope: "worktree", slot: 4 },
    ]);
    expect(normalizeClearBindings(undefined)).toEqual([]);
  });

  it("builds nested Hyprnav environment ids", () => {
    expect(
      buildHyprnavEnvironmentIds({
        projectRoot: "/repo",
        worktreePath: "/repo/worktrees/feature-a",
        threadId: "thread-1",
      }),
    ).toEqual({
      projectEnvId: "p.816fc349d3fa",
      worktreeEnvId: "p.816fc349d3fa.w.7d4d8df2de1b",
      threadEnvId: "p.816fc349d3fa.w.7d4d8df2de1b.t.thread-1",
      lockEnvId: "p.816fc349d3fa.w.7d4d8df2de1b.t.thread-1",
      targetPath: "/repo/worktrees/feature-a",
    });
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

  it("expands Hyprnav command templates", () => {
    expect(
      expandHyprnavCommandTemplate("printf %s {threadId} {worktreePath}", {
        projectRoot: "/repo",
        targetPath: "/repo/worktrees/feature-a",
        threadId: "thread-1",
        corkdiffConnection: {
          serverUrl: "ws://127.0.0.1:1234/ws",
          token: null,
        },
      }),
    ).toEqual({
      ok: true,
      command: "printf %s 'thread-1' '/repo/worktrees/feature-a'",
    });
  });
});

describe("HyprnavEnvironmentSync", () => {
  it("locks the explicit environment id without syncing slots", async () => {
    const spawnSync = vi.fn(() => spawnSyncResult());
    const sync = createHyprnavEnvironmentSync({
      spawnSync: spawnSync as unknown as typeof ChildProcess.spawnSync,
    });

    await expect(
      sync.lockEnvironment({ envId: "p.project.w.worktree.t.thread-1" }),
    ).resolves.toEqual({ status: "ok", message: null });

    expect(spawnSync.mock.calls).toEqual([
      ["hyprnav", ["lock", "p.project.w.worktree.t.thread-1"], expect.any(Object)],
    ]);
  });

  it("ensures nested environments, clears scoped slots, assigns commands, and locks the thread env", async () => {
    const spawnSync = vi.fn(() => spawnSyncResult());
    const sync = createHyprnavEnvironmentSync({
      spawnSync: spawnSync as unknown as typeof ChildProcess.spawnSync,
      resolvePath: (value: string) => `/resolved${value}`,
      realpathSync: (value: string) => `/real${value}`,
    });

    await expect(
      sync.sync({
        projectRoot: "/repo",
        worktreePath: "/repo/worktrees/feature-a",
        threadId: "thread-1",
        threadTitle: "Thread Alpha",
        preferredEditor: "cursor",
        corkdiffConnection: {
          serverUrl: "ws://127.0.0.1:1234/ws?wsToken=abc",
          token: null,
        },
        hyprnav: {
          bindings: [
            {
              id: "terminal",
              slot: 1,
              scope: "worktree",
              workspace: DEFAULT_PROJECT_HYPRNAV_WORKSPACE_TARGET,
              action: "worktree-terminal",
            },
            {
              id: "editor",
              slot: 2,
              scope: "project",
              workspace: DEFAULT_PROJECT_HYPRNAV_WORKSPACE_TARGET,
              action: "open-favorite-editor",
            },
            {
              id: "corkdiff",
              slot: 8,
              scope: "thread",
              workspace: DEFAULT_PROJECT_HYPRNAV_WORKSPACE_TARGET,
              action: "shell-command",
              command: "{corkdiffLaunchCommand}",
            },
          ],
        },
        clearBindings: [
          { scope: "project", slot: 4 },
          { scope: "thread", slot: 9 },
        ],
        lock: true,
      }),
    ).resolves.toEqual({ status: "ok", message: null });

    expect(spawnSync.mock.calls).toEqual([
      [
        "hyprnav",
        [
          "env",
          "ensure",
          "--env",
          "p.81cede1a43fc",
          "--cwd",
          "/real/resolved/repo",
          "--client",
          "t3code",
        ],
        expect.any(Object),
      ],
      [
        "hyprnav",
        [
          "env",
          "ensure",
          "--env",
          "p.81cede1a43fc.w.9430f831f299",
          "--cwd",
          "/real/resolved/repo/worktrees/feature-a",
          "--client",
          "t3code",
        ],
        expect.any(Object),
      ],
      [
        "hyprnav",
        [
          "env",
          "ensure",
          "--env",
          "p.81cede1a43fc.w.9430f831f299.t.thread-1",
          "--cwd",
          "/real/resolved/repo/worktrees/feature-a",
          "--title",
          "Thread Alpha",
          "--client",
          "t3code",
        ],
        expect.any(Object),
      ],
      [
        "hyprnav",
        ["slot", "command", "clear", "--env", "p.81cede1a43fc", "--slot", "4"],
        expect.any(Object),
      ],
      ["hyprnav", ["slot", "clear", "--env", "p.81cede1a43fc", "--slot", "4"], expect.any(Object)],
      [
        "hyprnav",
        [
          "slot",
          "command",
          "clear",
          "--env",
          "p.81cede1a43fc.w.9430f831f299.t.thread-1",
          "--slot",
          "9",
        ],
        expect.any(Object),
      ],
      [
        "hyprnav",
        ["slot", "clear", "--env", "p.81cede1a43fc.w.9430f831f299.t.thread-1", "--slot", "9"],
        expect.any(Object),
      ],
      [
        "hyprnav",
        [
          "slot",
          "assign",
          "--env",
          "p.81cede1a43fc.w.9430f831f299",
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
          "p.81cede1a43fc.w.9430f831f299",
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
          "--env",
          "p.81cede1a43fc",
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
          "p.81cede1a43fc",
          "--slot",
          "2",
          "--",
          "sh",
          "-lc",
          "'cursor' '/real/resolved/repo'",
        ],
        expect.any(Object),
      ],
      [
        "hyprnav",
        [
          "slot",
          "assign",
          "--env",
          "p.81cede1a43fc.w.9430f831f299.t.thread-1",
          "--slot",
          "8",
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
          "p.81cede1a43fc.w.9430f831f299.t.thread-1",
          "--slot",
          "8",
          "--",
          "sh",
          "-lc",
          expect.any(String),
        ],
        expect.any(Object),
      ],
      ["hyprnav", ["lock", "p.81cede1a43fc.w.9430f831f299.t.thread-1"], expect.any(Object)],
    ]);

    const corkdiffCommandSetCall = spawnSync.mock.calls.find((call) => {
      const args = getSpawnSyncArgs(call);
      return (
        args?.[0] === "slot" &&
        args[1] === "command" &&
        args[2] === "set" &&
        args.includes("p.81cede1a43fc.w.9430f831f299.t.thread-1") &&
        args.includes("8")
      );
    });
    const corkdiffCommand = getSpawnSyncArgs(corkdiffCommandSetCall ?? [])?.at(-1);
    expect(corkdiffCommand).toContain(
      "cd '/real/resolved/repo/worktrees/feature-a' && exec ghostty",
    );
    expect(corkdiffCommand).toContain("--class=dev.t3tools.t3code.corkdiff.t4b0a5fefc328");
    expect(corkdiffCommand).toContain("CorkDiff t3code thread-1");
    expect(corkdiffCommand).not.toContain("hyprnav spawn");
  });

  it("uses absolute workspace assignment when a binding targets a fixed workspace", async () => {
    const spawnSync = vi.fn(() => spawnSyncResult());
    const sync = createHyprnavEnvironmentSync({
      spawnSync: spawnSync as unknown as typeof ChildProcess.spawnSync,
      resolvePath: (value: string) => value,
      realpathSync: (value: string) => value,
    });

    await expect(
      sync.sync({
        projectRoot: "/repo",
        worktreePath: "/repo/worktrees/feature-a",
        threadId: "thread-1",
        preferredEditor: "cursor",
        corkdiffConnection: null,
        hyprnav: {
          bindings: [
            {
              id: "terminal",
              slot: 1,
              scope: "worktree",
              workspace: DEFAULT_PROJECT_HYPRNAV_WORKSPACE_TARGET,
              action: "worktree-terminal",
            },
            {
              id: "custom",
              slot: 4,
              scope: "project",
              name: "API",
              workspace: { mode: "absolute", workspaceId: 12 },
              action: "shell-command",
              command: "printf hi",
            },
          ],
        },
        lock: false,
      }),
    ).resolves.toEqual({ status: "ok", message: null });

    const managedAssignCall = spawnSync.mock.calls.find((call) => {
      const args = getSpawnSyncArgs(call);
      return (
        args?.[0] === "slot" &&
        args[1] === "assign" &&
        args[2] === "--env" &&
        args[4] === "--slot" &&
        args[5] === "1"
      );
    });
    expect(getSpawnSyncArgs(managedAssignCall ?? [])).toEqual([
      "slot",
      "assign",
      "--env",
      "p.816fc349d3fa.w.7d4d8df2de1b",
      "--slot",
      "1",
      "--managed",
      "--client",
      "t3code",
    ]);

    const absoluteAssignCall = spawnSync.mock.calls.find((call) => {
      const args = getSpawnSyncArgs(call);
      return (
        args?.[0] === "slot" &&
        args[1] === "assign" &&
        args[2] === "--env" &&
        args[4] === "--slot" &&
        args[5] === "4"
      );
    });
    expect(getSpawnSyncArgs(absoluteAssignCall ?? [])).toEqual([
      "slot",
      "assign",
      "--env",
      "p.816fc349d3fa",
      "--slot",
      "4",
      "--workspace",
      "12",
      "--name",
      "API",
      "--client",
      "t3code",
    ]);

    const absoluteCommandSetCall = spawnSync.mock.calls.find((call) => {
      const args = getSpawnSyncArgs(call);
      return (
        args?.[0] === "slot" &&
        args[1] === "command" &&
        args[2] === "set" &&
        args[4] === "p.816fc349d3fa" &&
        args[6] === "4"
      );
    });
    expect(getSpawnSyncArgs(absoluteCommandSetCall ?? [])).toEqual([
      "slot",
      "command",
      "set",
      "--env",
      "p.816fc349d3fa",
      "--slot",
      "4",
      "--name",
      "API",
      "--",
      "sh",
      "-lc",
      "printf hi",
    ]);
  });

  it("keeps slot assignment and clears the command for nothing bindings", async () => {
    const spawnSync = vi.fn(() => spawnSyncResult());
    const sync = createHyprnavEnvironmentSync({
      spawnSync: spawnSync as unknown as typeof ChildProcess.spawnSync,
      resolvePath: (value: string) => value,
      realpathSync: (value: string) => value,
    });

    await expect(
      sync.sync({
        projectRoot: "/repo",
        worktreePath: "/repo/worktrees/feature-a",
        threadId: "thread-1",
        preferredEditor: "cursor",
        corkdiffConnection: null,
        hyprnav: {
          bindings: [
            {
              id: "placeholder",
              slot: 5,
              scope: "project",
              name: "Docs",
              workspace: { mode: "absolute", workspaceId: 7 },
              action: "nothing",
            },
          ],
        },
        lock: false,
      }),
    ).resolves.toEqual({ status: "ok", message: null });

    const assignCall = spawnSync.mock.calls.find((call) => {
      const args = getSpawnSyncArgs(call);
      return (
        args?.[0] === "slot" && args[1] === "assign" && args[4] === "--slot" && args[5] === "5"
      );
    });
    expect(getSpawnSyncArgs(assignCall ?? [])).toEqual([
      "slot",
      "assign",
      "--env",
      "p.816fc349d3fa",
      "--slot",
      "5",
      "--workspace",
      "7",
      "--name",
      "Docs",
      "--client",
      "t3code",
    ]);

    const commandClearCall = spawnSync.mock.calls.find((call) => {
      const args = getSpawnSyncArgs(call);
      return (
        args?.[0] === "slot" &&
        args[1] === "command" &&
        args[2] === "clear" &&
        args[4] === "p.816fc349d3fa" &&
        args[6] === "5"
      );
    });
    expect(getSpawnSyncArgs(commandClearCall ?? [])).toEqual([
      "slot",
      "command",
      "clear",
      "--env",
      "p.816fc349d3fa",
      "--slot",
      "5",
    ]);

    expect(
      spawnSync.mock.calls.some((call) => {
        const args = getSpawnSyncArgs(call);
        return (
          args?.[0] === "slot" &&
          args[1] === "command" &&
          args[2] === "set" &&
          args[4] === "p.816fc349d3fa" &&
          args[6] === "5"
        );
      }),
    ).toBe(false);
  });

  it("skips thread-scoped bindings when there is no active thread id", async () => {
    const spawnSync = vi.fn(() => spawnSyncResult());
    const sync = createHyprnavEnvironmentSync({
      spawnSync: spawnSync as unknown as typeof ChildProcess.spawnSync,
      resolvePath: (value: string) => value,
      realpathSync: (value: string) => value,
    });

    await expect(
      sync.sync({
        projectRoot: "/repo",
        worktreePath: null,
        threadId: null,
        hyprnav: {
          bindings: [
            {
              id: "corkdiff",
              slot: 8,
              scope: "thread",
              workspace: DEFAULT_PROJECT_HYPRNAV_WORKSPACE_TARGET,
              action: "shell-command",
              command: "{corkdiffLaunchCommand}",
            },
          ],
        },
        lock: false,
      }),
    ).resolves.toEqual({ status: "ok", message: null });

    expect(
      spawnSync.mock.calls.every((call) => {
        const args = getSpawnSyncArgs(call);
        return !args?.includes("t.null");
      }),
    ).toBe(true);
  });

  it("clears stored slot names explicitly when requested", async () => {
    const spawnSync = vi.fn(() => spawnSyncResult());
    const sync = createHyprnavEnvironmentSync({
      spawnSync: spawnSync as unknown as typeof ChildProcess.spawnSync,
      resolvePath: (value: string) => value,
      realpathSync: (value: string) => value,
    });

    await expect(
      sync.sync({
        projectRoot: "/repo",
        hyprnav: {
          bindings: [],
        },
        clearNames: [{ scope: "project", slot: 3 }],
        lock: false,
      }),
    ).resolves.toEqual({ status: "ok", message: null });

    expect(spawnSync.mock.calls).toContainEqual([
      "hyprnav",
      ["slot", "name", "clear", "--env", "p.816fc349d3fa", "--slot", "3"],
      expect.any(Object),
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
        projectRoot: "/repo",
        hyprnav: {
          bindings: [
            {
              id: "custom",
              slot: 3,
              scope: "project",
              workspace: DEFAULT_PROJECT_HYPRNAV_WORKSPACE_TARGET,
              action: "shell-command",
              command: "echo hi",
            },
          ],
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
        projectRoot: "/repo",
        hyprnav: {
          bindings: [
            {
              id: "editor",
              slot: 2,
              scope: "project",
              workspace: DEFAULT_PROJECT_HYPRNAV_WORKSPACE_TARGET,
              action: "open-favorite-editor",
            },
          ],
        },
        lock: false,
      }),
    ).resolves.toEqual({
      status: "unavailable",
      message: "No available favorite editor is configured.",
    });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("coalesces rapid requests for the same nested environment", async () => {
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
      projectRoot: "/repo",
      worktreePath: "/repo/worktrees/feature-a",
      threadId: "thread-1",
      hyprnav: {
        bindings: [
          {
            id: "first",
            slot: 1,
            scope: "project",
            workspace: DEFAULT_PROJECT_HYPRNAV_WORKSPACE_TARGET,
            action: "shell-command",
            command: "one",
          },
        ],
      },
      clearBindings: [{ scope: "project", slot: 7 }],
      lock: false,
    });
    const second = sync.sync({
      projectRoot: "/repo",
      worktreePath: "/repo/worktrees/feature-a",
      threadId: "thread-1",
      hyprnav: {
        bindings: [
          {
            id: "second",
            slot: 3,
            scope: "thread",
            workspace: DEFAULT_PROJECT_HYPRNAV_WORKSPACE_TARGET,
            action: "shell-command",
            command: "two",
          },
        ],
      },
      clearBindings: [{ scope: "thread", slot: 8 }],
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
        return args?.[0] === "lock" && args[1] === "p.816fc349d3fa.w.7d4d8df2de1b.t.thread-1";
      }),
    ).toBe(true);
    expect(
      spawnSync.mock.calls.some((call) => {
        const args = getSpawnSyncArgs(call);
        return (
          args?.[0] === "slot" &&
          args[1] === "clear" &&
          args.includes("p.816fc349d3fa") &&
          args.includes("7")
        );
      }),
    ).toBe(true);
    expect(
      spawnSync.mock.calls.some((call) => {
        const args = getSpawnSyncArgs(call);
        return (
          args?.[0] === "slot" &&
          args[1] === "clear" &&
          args.includes("p.816fc349d3fa.w.7d4d8df2de1b.t.thread-1") &&
          args.includes("8")
        );
      }),
    ).toBe(true);
  });
});
