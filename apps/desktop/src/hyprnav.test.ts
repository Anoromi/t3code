// @effect-diagnostics nodeBuiltinImport:off
import { EventEmitter } from "node:events";
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

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: ChildProcess.SpawnOptionsWithoutStdio;
  readonly child: MockChildProcess;
}

class MockReadable extends EventEmitter {
  setEncoding(_encoding: BufferEncoding): this {
    return this;
  }
}

class MockWritable extends EventEmitter {
  readonly writes: string[] = [];

  end(chunk?: string, _encoding?: BufferEncoding, callback?: (error?: Error | null) => void): void {
    if (typeof chunk === "string") {
      this.writes.push(chunk);
    }
    callback?.(null);
  }
}

class MockChildProcess extends EventEmitter {
  readonly stdout = new MockReadable();
  readonly stderr = new MockReadable();
  readonly stdin = new MockWritable();
  readonly killedSignals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killedSignals.push(signal);
    return true;
  }

  succeed(stdout = "", stderr = ""): void {
    if (stdout.length > 0) {
      this.stdout.emit("data", stdout);
    }
    if (stderr.length > 0) {
      this.stderr.emit("data", stderr);
    }
    this.emit("exit", 0, null);
  }

  fail(code: number, stderr = ""): void {
    if (stderr.length > 0) {
      this.stderr.emit("data", stderr);
    }
    this.emit("exit", code, null);
  }
}

function createSpawnMock() {
  const calls: SpawnCall[] = [];
  const spawn = vi.fn(
    (
      command: string,
      args: readonly string[],
      options: ChildProcess.SpawnOptionsWithoutStdio = {},
    ) => {
      const child = new MockChildProcess();
      calls.push({ command, args, options, child });
      return child as unknown as ChildProcess.ChildProcessWithoutNullStreams;
    },
  );
  return { spawn, calls };
}

async function flushAsyncDrain(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function getBatchPayload(call: SpawnCall): {
  readonly atomic: boolean;
  readonly operations: ReadonlyArray<{
    readonly op?: string;
    readonly env?: string;
    readonly slot?: number;
    readonly argv?: ReadonlyArray<string>;
    readonly [key: string]: unknown;
  }>;
} | null {
  if (call.args[0] !== "batch" || call.args[1] !== "--stdin") {
    return null;
  }
  const input = call.child.stdin.writes.join("");
  if (input.length === 0) {
    return null;
  }
  return JSON.parse(input) as {
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
    const { spawn, calls } = createSpawnMock();
    const sync = createHyprnavEnvironmentSync({
      spawn: spawn as unknown as typeof ChildProcess.spawn,
      resolvePath: (value: string) => value,
      realpathSync: (value: string) => value,
    });

    const resultPromise = sync.lockEnvironment({ envId: "p.project.w.worktree.t.thread-1" });
    await flushAsyncDrain();
    expect(calls).toHaveLength(1);
    calls[0]!.child.succeed();

    await expect(resultPromise).resolves.toEqual({ status: "ok", message: null });
    expect(calls.map((call) => [call.command, call.args])).toEqual([
      ["hyprnav", ["lock", "p.project.w.worktree.t.thread-1"]],
    ]);
  });

  it("ensures nested environments, clears scoped slots, assigns commands, and locks the thread env", async () => {
    const { spawn, calls } = createSpawnMock();
    const sync = createHyprnavEnvironmentSync({
      spawn: spawn as unknown as typeof ChildProcess.spawn,
      resolvePath: (value: string) => `/resolved${value}`,
      realpathSync: (value: string) => `/real${value}`,
    });

    const resultPromise = sync.sync({
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
    });

    await flushAsyncDrain();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["batch", "--stdin"]);

    const payload = getBatchPayload(calls[0]!);
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

    calls[0]!.child.succeed();
    await flushAsyncDrain();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.command).toBe("hyprnav");
    expect(calls[1]!.args).toEqual(["lock", "p.81cede1a43fc.w.9430f831f299.t.thread-1"]);
    calls[1]!.child.succeed();
    await expect(resultPromise).resolves.toEqual({ status: "ok", message: null });
  });

  it("uses absolute workspace assignment when a binding targets a fixed workspace", async () => {
    const { spawn, calls } = createSpawnMock();
    const sync = createHyprnavEnvironmentSync({
      spawn: spawn as unknown as typeof ChildProcess.spawn,
      resolvePath: (value: string) => value,
      realpathSync: (value: string) => value,
    });

    const resultPromise = sync.sync({
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
    });

    await flushAsyncDrain();
    const payload = getBatchPayload(calls[0]!);
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

    calls[0]!.child.succeed();
    await expect(resultPromise).resolves.toEqual({ status: "ok", message: null });
  });

  it("keeps slot assignment and clears the command for nothing bindings", async () => {
    const { spawn, calls } = createSpawnMock();
    const sync = createHyprnavEnvironmentSync({
      spawn: spawn as unknown as typeof ChildProcess.spawn,
      resolvePath: (value: string) => value,
      realpathSync: (value: string) => value,
    });

    const resultPromise = sync.sync({
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
    });

    await flushAsyncDrain();
    const payload = getBatchPayload(calls[0]!);
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

    calls[0]!.child.succeed();
    await expect(resultPromise).resolves.toEqual({ status: "ok", message: null });
  });

  it("skips thread-scoped bindings when there is no active thread id", async () => {
    const { spawn, calls } = createSpawnMock();
    const sync = createHyprnavEnvironmentSync({
      spawn: spawn as unknown as typeof ChildProcess.spawn,
      resolvePath: (value: string) => value,
      realpathSync: (value: string) => value,
    });

    const resultPromise = sync.sync({
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
    });

    await flushAsyncDrain();
    expect(calls.every((call) => !call.args.includes("t.null"))).toBe(true);
    expect(calls).toHaveLength(0);
    await expect(resultPromise).resolves.toEqual({ status: "ok", message: null });
  });

  it("only ensures the thread environment for thread-only sync jobs", async () => {
    const { spawn, calls } = createSpawnMock();
    const sync = createHyprnavEnvironmentSync({
      spawn: spawn as unknown as typeof ChildProcess.spawn,
      resolvePath: (value: string) => value,
      realpathSync: (value: string) => value,
    });

    const resultPromise = sync.sync({
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
    });

    await flushAsyncDrain();
    const payload = getBatchPayload(calls[0]!);
    const ensuredEnvIds = payload?.operations.flatMap((operation) =>
      operation.op === "env_ensure" ? [String(operation.env)] : [],
    );
    expect(ensuredEnvIds).toEqual(["p.816fc349d3fa.w.7d4d8df2de1b.t.thread-1"]);

    calls[0]!.child.succeed();
    await expect(resultPromise).resolves.toEqual({ status: "ok", message: null });
  });

  it("clears stored slot names explicitly when requested", async () => {
    const { spawn, calls } = createSpawnMock();
    const sync = createHyprnavEnvironmentSync({
      spawn: spawn as unknown as typeof ChildProcess.spawn,
      resolvePath: (value: string) => value,
      realpathSync: (value: string) => value,
    });

    const resultPromise = sync.sync({
      projectRoot: "/repo",
      hyprnav: {
        bindings: [],
      },
      clearNames: [{ scope: "project", slot: 3 }],
      lock: false,
    });

    await flushAsyncDrain();
    const payload = getBatchPayload(calls[0]!);
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

    calls[0]!.child.succeed();
    await expect(resultPromise).resolves.toEqual({ status: "ok", message: null });
  });

  it("returns unavailable when hyprnav is missing", async () => {
    const spawn = vi.fn(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const sync = createHyprnavEnvironmentSync({
      spawn: spawn as unknown as typeof ChildProcess.spawn,
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

  it("returns an error when hyprnav exits non-zero", async () => {
    const { spawn, calls } = createSpawnMock();
    const sync = createHyprnavEnvironmentSync({
      spawn: spawn as unknown as typeof ChildProcess.spawn,
      resolvePath: (value: string) => value,
      realpathSync: (value: string) => value,
    });

    const resultPromise = sync.sync({
      projectRoot: "/repo",
      hyprnav: {
        bindings: [],
      },
      clearNames: [{ scope: "project", slot: 3 }],
      lock: false,
    });

    await flushAsyncDrain();
    calls[0]!.child.fail(1, "boom");
    await expect(resultPromise).resolves.toEqual({
      status: "error",
      message: "hyprnav batch --stdin: boom",
    });
  });

  it("returns an error when hyprnav times out and kills the child", async () => {
    vi.useFakeTimers();
    try {
      const { spawn, calls } = createSpawnMock();
      const sync = createHyprnavEnvironmentSync({
        spawn: spawn as unknown as typeof ChildProcess.spawn,
        resolvePath: (value: string) => value,
        realpathSync: (value: string) => value,
        timeoutMs: 5_000,
      });

      const resultPromise = sync.sync({
        projectRoot: "/repo",
        hyprnav: {
          bindings: [],
        },
        clearNames: [{ scope: "project", slot: 3 }],
        lock: false,
      });

      await flushAsyncDrain();
      await vi.advanceTimersByTimeAsync(5_000);
      calls[0]!.child.emit("exit", null, "SIGTERM");

      await expect(resultPromise).resolves.toEqual({
        status: "error",
        message: "hyprnav batch --stdin timed out.",
      });
      expect(calls[0]!.child.killedSignals).toContain("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns unavailable when favorite editor action has no editor", async () => {
    const { spawn } = createSpawnMock();
    const sync = createHyprnavEnvironmentSync({
      spawn: spawn as unknown as typeof ChildProcess.spawn,
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
    expect(spawn).not.toHaveBeenCalled();
  });

  it("coalesces rapid requests for the same nested environment", async () => {
    const { spawn, calls } = createSpawnMock();
    const sync = createHyprnavEnvironmentSync({
      spawn: spawn as unknown as typeof ChildProcess.spawn,
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

    await flushAsyncDrain();
    expect(calls).toHaveLength(1);
    calls[0]!.child.succeed();
    await flushAsyncDrain();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.command).toBe("hyprnav");
    expect(calls[1]!.args).toEqual(["lock", "p.816fc349d3fa.w.7d4d8df2de1b.t.thread-1"]);
    calls[1]!.child.succeed();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "ok", message: null },
      { status: "ok", message: null },
    ]);

    const operations = calls.flatMap((call) => getBatchPayload(call)?.operations ?? []);
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
