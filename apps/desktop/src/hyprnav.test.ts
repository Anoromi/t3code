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

function getSpawnSyncOptions(
  call: readonly unknown[],
): ChildProcess.SpawnSyncOptionsWithStringEncoding | null {
  const options = call[2];
  return options && typeof options === "object"
    ? (options as ChildProcess.SpawnSyncOptionsWithStringEncoding)
    : null;
}

function getBatchPayload(call: readonly unknown[]): {
  readonly atomic: boolean;
  readonly operations: ReadonlyArray<{
    readonly op?: string;
    readonly env?: string;
    readonly slot?: number;
    readonly argv?: ReadonlyArray<string>;
    readonly [key: string]: unknown;
  }>;
} | null {
  const args = getSpawnSyncArgs(call);
  if (!args || args[0] !== "batch" || args[1] !== "--stdin") {
    return null;
  }
  const options = getSpawnSyncOptions(call);
  if (!options || typeof options.input !== "string") {
    return null;
  }
  return JSON.parse(options.input) as {
    readonly atomic: boolean;
    readonly operations: ReadonlyArray<{
      readonly op?: string;
      readonly env?: string;
      readonly slot?: number;
      readonly argv?: ReadonlyArray<string>;
      readonly [key: string]: unknown;
    }>;
  };
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

    expect(spawnSync.mock.calls).toHaveLength(1);
    expect(getSpawnSyncArgs(spawnSync.mock.calls[0]!)).toEqual(["batch", "--stdin"]);

    const payload = getBatchPayload(spawnSync.mock.calls[0]!);
    expect(payload).not.toBeNull();
    expect(payload?.atomic).toBe(true);
    expect(payload?.operations).toEqual([
      {
        op: "env_ensure",
        env: "p.81cede1a43fc",
        cwd: "/real/resolved/repo",
        client: "t3code",
      },
      {
        op: "env_ensure",
        env: "p.81cede1a43fc.w.9430f831f299",
        cwd: "/real/resolved/repo/worktrees/feature-a",
        client: "t3code",
      },
      {
        op: "env_ensure",
        env: "p.81cede1a43fc.w.9430f831f299.t.thread-1",
        cwd: "/real/resolved/repo/worktrees/feature-a",
        title: "Thread Alpha",
        client: "t3code",
      },
      { op: "slot_command_clear", env: "p.81cede1a43fc", slot: 4 },
      { op: "slot_clear", env: "p.81cede1a43fc", slot: 4, client: "t3code" },
      { op: "slot_command_clear", env: "p.81cede1a43fc.w.9430f831f299.t.thread-1", slot: 9 },
      {
        op: "slot_clear",
        env: "p.81cede1a43fc.w.9430f831f299.t.thread-1",
        slot: 9,
        client: "t3code",
      },
      {
        op: "slot_assign",
        env: "p.81cede1a43fc.w.9430f831f299",
        slot: 1,
        assignment_mode: { mode: "managed" },
        client: "t3code",
      },
      {
        op: "slot_command_set",
        env: "p.81cede1a43fc.w.9430f831f299",
        slot: 1,
        argv: [
          "sh",
          "-lc",
          "exec ghostty --gtk-single-instance=false --working-directory='/real/resolved/repo/worktrees/feature-a' -e sh -lc 'exec tmux'",
        ],
      },
      {
        op: "slot_assign",
        env: "p.81cede1a43fc",
        slot: 2,
        assignment_mode: { mode: "managed" },
        client: "t3code",
      },
      {
        op: "slot_command_set",
        env: "p.81cede1a43fc",
        slot: 2,
        argv: ["sh", "-lc", "'cursor' '/real/resolved/repo'"],
      },
      {
        op: "slot_assign",
        env: "p.81cede1a43fc.w.9430f831f299.t.thread-1",
        slot: 8,
        assignment_mode: { mode: "managed" },
        client: "t3code",
      },
      expect.objectContaining({
        op: "slot_command_set",
        env: "p.81cede1a43fc.w.9430f831f299.t.thread-1",
        slot: 8,
        argv: expect.any(Array),
      }),
      { op: "lock_set", env: "p.81cede1a43fc.w.9430f831f299.t.thread-1" },
    ]);

    const corkdiffCommand = (payload?.operations.at(12)?.argv as readonly string[] | undefined)?.at(
      2,
    );
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

    const payload = getBatchPayload(spawnSync.mock.calls[0]!);
    expect(payload?.operations).toEqual(
      expect.arrayContaining([
        {
          op: "slot_assign",
          env: "p.816fc349d3fa.w.7d4d8df2de1b",
          slot: 1,
          assignment_mode: { mode: "managed" },
          client: "t3code",
        },
        {
          op: "slot_assign",
          env: "p.816fc349d3fa",
          slot: 4,
          assignment_mode: { mode: "fixed", workspace_id: 12 },
          display_name: "API",
          client: "t3code",
        },
        {
          op: "slot_command_set",
          env: "p.816fc349d3fa",
          slot: 4,
          display_name: "API",
          argv: ["sh", "-lc", "printf hi"],
        },
      ]),
    );
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

    const payload = getBatchPayload(spawnSync.mock.calls[0]!);
    expect(payload?.operations).toEqual(
      expect.arrayContaining([
        {
          op: "slot_assign",
          env: "p.816fc349d3fa",
          slot: 5,
          assignment_mode: { mode: "fixed", workspace_id: 7 },
          display_name: "Docs",
          client: "t3code",
        },
        {
          op: "slot_command_clear",
          env: "p.816fc349d3fa",
          slot: 5,
        },
      ]),
    );
    expect(
      payload?.operations.some(
        (operation) =>
          operation.op === "slot_command_set" &&
          operation.env === "p.816fc349d3fa" &&
          operation.slot === 5,
      ),
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

  it("only ensures the thread environment for thread-only sync jobs", async () => {
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
        threadTitle: "Thread Alpha",
        hyprnav: {
          bindings: [
            {
              id: "corkdiff",
              slot: 8,
              scope: "thread",
              workspace: DEFAULT_PROJECT_HYPRNAV_WORKSPACE_TARGET,
              action: "shell-command",
              command: "printf thread-only",
            },
          ],
        },
        clearBindings: [{ scope: "thread", slot: 9 }],
        clearNames: [{ scope: "thread", slot: 10 }],
        lock: false,
      }),
    ).resolves.toEqual({ status: "ok", message: null });

    const payload = getBatchPayload(spawnSync.mock.calls[0]!);
    const ensuredEnvIds = payload?.operations.flatMap((operation) =>
      operation.op === "env_ensure" ? [String(operation.env)] : [],
    );
    expect(ensuredEnvIds).toEqual(["p.816fc349d3fa.w.7d4d8df2de1b.t.thread-1"]);
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

    const payload = getBatchPayload(spawnSync.mock.calls[0]!);
    expect(payload?.operations).toEqual(
      expect.arrayContaining([
        {
          op: "env_ensure",
          env: "p.816fc349d3fa",
          cwd: "/repo",
          client: "t3code",
        },
        { op: "slot_name_clear", env: "p.816fc349d3fa", slot: 3 },
      ]),
    );
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
    const operations = spawnSync.mock.calls.flatMap(
      (call) => getBatchPayload(call)?.operations ?? [],
    );
    expect(
      operations.some(
        (operation) =>
          operation.op === "lock_set" &&
          operation.env === "p.816fc349d3fa.w.7d4d8df2de1b.t.thread-1",
      ),
    ).toBe(true);
    expect(
      operations.some(
        (operation) =>
          operation.op === "slot_clear" &&
          operation.env === "p.816fc349d3fa" &&
          operation.slot === 7,
      ),
    ).toBe(true);
    expect(
      operations.some(
        (operation) =>
          operation.op === "slot_clear" &&
          operation.env === "p.816fc349d3fa.w.7d4d8df2de1b.t.thread-1" &&
          operation.slot === 8,
      ),
    ).toBe(true);
  });
});
