import { describe, expect, it } from "vitest";

import {
  buildShellLaunchCommand,
  buildSpawnDispatch,
  createAssignmentKey,
  createPidFileName,
  ensureWorkspaceAssignment,
  killProcessTree,
  parseRegistry,
  pruneAssignments,
  quoteShellArg,
  resolveCommandString,
  resolvePidFilePath,
  resolveSpawnOptions,
  runCli,
  selectWorkspace,
  serializeRegistry,
  type ResolvedWorktree,
  type WorkspaceAssignment,
  type WorkspaceRegistry,
} from "./hypr-worktree.ts";

class MemoryFileSystem {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();

  existsSync = (path: string): boolean => this.files.has(path) || this.directories.has(path);

  mkdirSync = (path: string): void => {
    this.directories.add(path);
  };

  readFileSync = (path: string): string => {
    const value = this.files.get(path);
    if (value === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }

    return value;
  };

  writeFileSync = (path: string, data: string): void => {
    this.files.set(path, data);
  };

  unlinkSync = (path: string): void => {
    if (!this.files.delete(path)) {
      const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
  };
}

function createWorktree(overrides: Partial<ResolvedWorktree> = {}): ResolvedWorktree {
  const repoCommonDir = overrides.repoCommonDir ?? "/repos/sample/.git";
  const worktreeRoot = overrides.worktreeRoot ?? "/repos/sample";

  return {
    cwd: overrides.cwd ?? `${worktreeRoot}/apps/web`,
    repoCommonDir,
    worktreeRoot,
    key: overrides.key ?? createAssignmentKey(repoCommonDir, worktreeRoot),
  };
}

function createAssignment(
  worktree: ResolvedWorktree,
  overrides: Partial<WorkspaceAssignment> = {},
): WorkspaceAssignment {
  return {
    repoCommonDir: overrides.repoCommonDir ?? worktree.repoCommonDir,
    worktreeRoot: overrides.worktreeRoot ?? worktree.worktreeRoot,
    workspace: overrides.workspace ?? 11,
    pid: overrides.pid ?? 0,
  };
}

function createCliDeps(input: {
  readonly argvWorktree?: ResolvedWorktree;
  readonly registry?: WorkspaceRegistry;
  readonly occupiedWorkspaces?: ReadonlySet<number>;
  readonly env?: NodeJS.ProcessEnv;
  readonly livePids?: ReadonlyArray<number>;
  readonly childPids?: Readonly<Record<number, ReadonlyArray<number>>>;
  readonly nextSpawnPid?: number;
}) {
  const fs = new MemoryFileSystem();
  const stateFilePath = "/state/hypr-workspaces/assignments.json";
  if (input.registry) {
    fs.files.set(stateFilePath, serializeRegistry(input.registry));
  }

  const killCalls: Array<string> = [];
  const dispatches: Array<string> = [];
  const outputs = { stdout: [] as Array<string>, stderr: [] as Array<string> };
  const worktree = input.argvWorktree ?? createWorktree();
  const livePids = new Set(input.livePids ?? []);
  const childPids = new Map<number, ReadonlyArray<number>>(
    Object.entries(input.childPids ?? {}).map(([pid, children]) => [Number(pid), children]),
  );
  const pidFilePath = resolvePidFilePath(
    {
      HYPRLAND_INSTANCE_SIGNATURE: "sig",
      XDG_STATE_HOME: "/state",
      ...input.env,
    },
    worktree.key,
    "/home/tester",
  );
  let nextSpawnPid = input.nextSpawnPid ?? 4321;

  return {
    deps: {
      cwd: () => worktree.cwd,
      env: {
        HYPRLAND_INSTANCE_SIGNATURE: "sig",
        XDG_STATE_HOME: "/state",
        ...input.env,
      },
      fileSystem: fs,
      homeDir: "/home/tester",
      resolveWorktreeFromCwd: () => worktree,
      resolveGitCommonDirForWorktree: (worktreeRoot: string) => {
        if (worktreeRoot === "/missing/worktree") {
          throw new Error("missing");
        }

        if (worktreeRoot === "/stale/worktree") {
          return "/repos/other/.git";
        }

        if (worktreeRoot === worktree.worktreeRoot) {
          return worktree.repoCommonDir;
        }

        return "/repos/other/.git";
      },
      listOccupiedWorkspaces: () => input.occupiedWorkspaces ?? new Set<number>(),
      dispatchWorkspace: (workspace: number) => {
        dispatches.push(`workspace:${String(workspace)}`);
      },
      dispatchExec: (command: string) => {
        dispatches.push(`exec:${command}`);
        fs.files.set(pidFilePath, `${String(nextSpawnPid)}\n`);
        livePids.add(nextSpawnPid);
        nextSpawnPid += 1;
      },
      isProcessAlive: (pid: number) => livePids.has(pid),
      listChildPids: (pid: number) => childPids.get(pid) ?? [],
      killProcess: (pid: number, signal: NodeJS.Signals | 0) => {
        killCalls.push(`${signal}:${String(pid)}`);
        if (signal !== 0) {
          livePids.delete(pid);
        }
      },
      sleep: async () => {},
      stdout: (line: string) => {
        outputs.stdout.push(line);
      },
      stderr: (line: string) => {
        outputs.stderr.push(line);
      },
    },
    dispatches,
    fs,
    killCalls,
    outputs,
    pidFilePath,
    stateFilePath,
    worktree,
  };
}

describe("hypr-worktree", () => {
  it("creates stable keys from repoCommonDir and worktreeRoot", () => {
    expect(createAssignmentKey("/repo/.git", "/repo")).toBe("/repo/.git::/repo");
  });

  it("selects the first workspace from 11 when none are reserved or occupied", () => {
    expect(
      selectWorkspace({
        workspaceStart: 11,
        occupiedWorkspaces: new Set<number>(),
        reservedWorkspaces: new Set<number>(),
      }),
    ).toBe(11);
  });

  it("skips occupied and reserved workspaces during allocation", () => {
    expect(
      selectWorkspace({
        workspaceStart: 11,
        occupiedWorkspaces: new Set([11, 12]),
        reservedWorkspaces: new Set([13]),
      }),
    ).toBe(14);
  });

  it("migrates version 1 registries by defaulting pid to 0", () => {
    const parsed = parseRegistry(
      JSON.stringify({
        version: 1,
        workspaceStart: 11,
        assignments: {
          "/repo/.git::/repo": {
            repoCommonDir: "/repo/.git",
            worktreeRoot: "/repo",
            workspace: 17,
          },
        },
      }),
    );

    expect(parsed.version).toBe(2);
    expect(parsed.assignments["/repo/.git::/repo"]?.pid).toBe(0);
    expect(serializeRegistry(parsed)).toContain('"version": 2');
    expect(serializeRegistry(parsed)).toContain('"pid": 0');
  });

  it("prunes assignments when the worktree no longer resolves to the same common dir", () => {
    const live = createWorktree();
    const staleKey = createAssignmentKey("/repos/sample/.git", "/stale/worktree");
    const registry: WorkspaceRegistry = {
      version: 2,
      workspaceStart: 11,
      assignments: {
        [live.key]: createAssignment(live, { workspace: 11 }),
        [staleKey]: {
          repoCommonDir: "/repos/sample/.git",
          worktreeRoot: "/stale/worktree",
          workspace: 12,
          pid: 4000,
        },
      },
    };

    const pruned = pruneAssignments(registry, (worktreeRoot) => {
      if (worktreeRoot === live.worktreeRoot) {
        return live.repoCommonDir;
      }

      return "/repos/other/.git";
    });

    expect(Object.keys(pruned.assignments)).toEqual([live.key]);
  });

  it("fails clearly on malformed registry JSON", () => {
    expect(() => parseRegistry("{not-json")).toThrow("Malformed hypr-workspaces registry JSON");
  });

  it("fails when an assignment key does not match the stored identity", () => {
    expect(() =>
      parseRegistry(
        JSON.stringify({
          version: 2,
          workspaceStart: 11,
          assignments: {
            bogus: {
              repoCommonDir: "/repo/.git",
              worktreeRoot: "/repo",
              workspace: 11,
              pid: 12,
            },
          },
        }),
      ),
    ).toThrow("key does not match");
  });

  it("reuses an existing assignment even if the workspace is currently occupied", () => {
    const worktree = createWorktree();
    const registry: WorkspaceRegistry = {
      version: 2,
      workspaceStart: 11,
      assignments: {
        [worktree.key]: createAssignment(worktree, { workspace: 17, pid: 51 }),
      },
    };

    const fs = new MemoryFileSystem();
    fs.files.set("/state/hypr-workspaces/assignments.json", serializeRegistry(registry));

    const result = ensureWorkspaceAssignment({
      stateFilePath: "/state/hypr-workspaces/assignments.json",
      fileSystem: fs,
      resolveGitCommonDirForWorktree: () => worktree.repoCommonDir,
      listOccupiedWorkspaces: () => new Set([17]),
      worktree,
    });

    expect(result.assignment.workspace).toBe(17);
    expect(result.assignment.pid).toBe(51);
  });

  it("writes a new assignment when none exists", () => {
    const worktree = createWorktree();
    const fs = new MemoryFileSystem();

    const result = ensureWorkspaceAssignment({
      stateFilePath: "/state/hypr-workspaces/assignments.json",
      fileSystem: fs,
      resolveGitCommonDirForWorktree: () => worktree.repoCommonDir,
      listOccupiedWorkspaces: () => new Set([11, 12]),
      worktree,
    });

    expect(result.assignment.workspace).toBe(13);
    expect(result.assignment.pid).toBe(0);
    expect(fs.files.get("/state/hypr-workspaces/assignments.json")).toContain('"workspace": 13');
    expect(fs.files.get("/state/hypr-workspaces/assignments.json")).toContain('"pid": 0');
  });

  it("builds a safe dispatch command for arbitrary shell payloads", () => {
    const dispatch = buildSpawnDispatch({
      workspace: 12,
      cwd: "/repo/path/that's/fine",
      command: `echo 'hello' && pnpm run dev`,
      silent: true,
      pidFilePath: "/tmp/pid file that's fine.txt",
    });

    expect(dispatch).toContain("[workspace 12 silent]");
    expect(dispatch).toContain(quoteShellArg("/repo/path/that's/fine"));
    expect(dispatch).toContain(quoteShellArg("/tmp/pid file that's fine.txt"));
    expect(dispatch).toContain(quoteShellArg(`echo 'hello' && pnpm run dev`));
  });

  it("keeps the non-managed helper shell-safe for direct command launches", () => {
    const command = buildShellLaunchCommand("/repo/path/that's/fine", "echo hi");

    expect(command).toContain(quoteShellArg("/repo/path/that's/fine"));
    expect(command).toContain(quoteShellArg("echo hi"));
  });

  it("creates stable hashed pid file names per worktree", () => {
    expect(createPidFileName("/repo/.git::/repo")).toMatch(/^pid-[0-9a-f]{16}\.txt$/);
  });

  it("parses spawn options and strips --silent", () => {
    expect(resolveSpawnOptions(["--silent", "--", "echo hi"])).toEqual({
      silent: true,
      remainingArgs: ["--", "echo hi"],
    });
  });

  it("requires a command string for spawn", () => {
    expect(() => resolveCommandString(["--"])).toThrow("Missing command");
  });

  it("where ensures an assignment and prints only the workspace number", async () => {
    const { deps, dispatches, outputs } = createCliDeps({
      occupiedWorkspaces: new Set([11]),
    });

    const result = await runCli(["where"], deps);

    expect(result.exitCode).toBe(0);
    expect(dispatches).toEqual([]);
    expect(outputs.stdout).toEqual(["12"]);
  });

  it("goto switches to the assigned workspace", async () => {
    const { deps, dispatches, outputs } = createCliDeps({});

    const result = await runCli(["goto"], deps);

    expect(result.exitCode).toBe(0);
    expect(dispatches).toEqual(["workspace:11"]);
    expect(outputs.stdout).toEqual(["11"]);
  });

  it("spawn switches first, records a pid, and launches on the assigned workspace", async () => {
    const { deps, dispatches, outputs, worktree, fs, stateFilePath } = createCliDeps({
      nextSpawnPid: 7001,
    });

    const result = await runCli(["spawn", "--", "pnpm run dev:desktop:wayland"], deps);

    expect(result.exitCode).toBe(0);
    expect(dispatches[0]).toBe("workspace:11");
    expect(dispatches[1]).toContain("exec:[workspace 11]");
    expect(dispatches[1]).toContain(quoteShellArg(worktree.cwd));
    expect(outputs.stdout).toEqual([`pid=7001 workspace=11 worktree=${worktree.worktreeRoot}`]);

    const storedRegistry = parseRegistry(fs.files.get(stateFilePath) ?? "");
    expect(storedRegistry.assignments[worktree.key]?.pid).toBe(7001);
  });

  it("spawn kills an existing live process tree before relaunching", async () => {
    const worktree = createWorktree();
    const registry: WorkspaceRegistry = {
      version: 2,
      workspaceStart: 11,
      assignments: {
        [worktree.key]: createAssignment(worktree, { workspace: 21, pid: 5000 }),
      },
    };
    const { deps, killCalls, outputs, fs, stateFilePath } = createCliDeps({
      argvWorktree: worktree,
      registry,
      livePids: [5000, 5001, 5002],
      childPids: {
        5000: [5001],
        5001: [5002],
      },
      nextSpawnPid: 8001,
    });

    const result = await runCli(["spawn", "--", "bun run dev:desktop:wayland"], deps);

    expect(result.exitCode).toBe(0);
    expect(killCalls).toEqual(["SIGTERM:5002", "SIGTERM:5001", "SIGTERM:5000"]);
    expect(outputs.stdout).toEqual([`pid=8001 workspace=21 worktree=${worktree.worktreeRoot}`]);

    const storedRegistry = parseRegistry(fs.files.get(stateFilePath) ?? "");
    expect(storedRegistry.assignments[worktree.key]?.pid).toBe(8001);
  });

  it("spawn ignores stale pids and relaunches cleanly", async () => {
    const worktree = createWorktree();
    const registry: WorkspaceRegistry = {
      version: 2,
      workspaceStart: 11,
      assignments: {
        [worktree.key]: createAssignment(worktree, { workspace: 14, pid: 9000 }),
      },
    };
    const { deps, killCalls, outputs } = createCliDeps({
      argvWorktree: worktree,
      registry,
      nextSpawnPid: 9001,
    });

    const result = await runCli(["spawn", "--", "bun run dev:desktop:wayland"], deps);

    expect(result.exitCode).toBe(0);
    expect(killCalls).toEqual([]);
    expect(outputs.stdout).toEqual([`pid=9001 workspace=14 worktree=${worktree.worktreeRoot}`]);
  });

  it("spawn --silent launches without switching first", async () => {
    const { deps, dispatches } = createCliDeps({});

    const result = await runCli(["spawn", "--silent", "--", "echo hi"], deps);

    expect(result.exitCode).toBe(0);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toContain("exec:[workspace 11 silent]");
  });

  it("fails clearly outside Hyprland", async () => {
    const { deps, outputs } = createCliDeps({
      env: { HYPRLAND_INSTANCE_SIGNATURE: "" },
    });

    const result = await runCli(["where"], deps);

    expect(result.exitCode).toBe(1);
    expect(outputs.stderr[0]).toContain("Hyprland does not appear to be running");
  });

  it("keeps the caller cwd for spawn instead of forcing the worktree root", async () => {
    const worktree = createWorktree({
      cwd: "/repos/sample/apps/web",
      worktreeRoot: "/repos/sample",
    });
    const { deps, dispatches } = createCliDeps({ argvWorktree: worktree });

    await runCli(["spawn", "--", "pnpm run dev"], deps);

    expect(dispatches[1]).toContain(quoteShellArg("/repos/sample/apps/web"));
    expect(dispatches[1]).not.toContain(quoteShellArg(worktree.worktreeRoot));
  });

  it("kills a process tree depth-first and skips already-dead children", async () => {
    const livePids = new Set([10, 11, 12]);
    const signals: Array<string> = [];

    await killProcessTree({
      pid: 10,
      isProcessAlive: (pid) => livePids.has(pid),
      listChildPids: (pid) => {
        if (pid === 10) return [11];
        if (pid === 11) return [12];
        return [];
      },
      killProcess: (pid, signal) => {
        signals.push(`${signal}:${String(pid)}`);
        livePids.delete(pid);
      },
      sleep: async () => {},
    });

    expect(signals).toEqual(["SIGTERM:12", "SIGTERM:11", "SIGTERM:10"]);
  });
});
