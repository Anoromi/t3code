import { describe, expect, it } from "vitest";

import {
  buildSpawnDispatch,
  createAssignmentKey,
  ensureWorkspaceAssignment,
  parseRegistry,
  pruneAssignments,
  quoteShellArg,
  resolveCommandString,
  resolveSpawnOptions,
  runCli,
  selectWorkspace,
  serializeRegistry,
  type ResolvedWorktree,
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

function createCliDeps(input: {
  readonly argvWorktree?: ResolvedWorktree;
  readonly registry?: WorkspaceRegistry;
  readonly occupiedWorkspaces?: ReadonlySet<number>;
  readonly env?: NodeJS.ProcessEnv;
}) {
  const fs = new MemoryFileSystem();
  const stateFilePath = "/state/hypr-workspaces/assignments.json";
  if (input.registry) {
    fs.files.set(stateFilePath, serializeRegistry(input.registry));
  }

  const dispatches: Array<string> = [];
  const outputs = { stdout: [] as Array<string>, stderr: [] as Array<string> };
  const worktree = input.argvWorktree ?? createWorktree();

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
      },
      stdout: (line: string) => {
        outputs.stdout.push(line);
      },
      stderr: (line: string) => {
        outputs.stderr.push(line);
      },
    },
    dispatches,
    fs,
    outputs,
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

  it("prunes assignments when the worktree no longer resolves to the same common dir", () => {
    const live = createWorktree();
    const staleKey = createAssignmentKey("/repos/sample/.git", "/stale/worktree");
    const registry: WorkspaceRegistry = {
      version: 1,
      workspaceStart: 11,
      assignments: {
        [live.key]: {
          repoCommonDir: live.repoCommonDir,
          worktreeRoot: live.worktreeRoot,
          workspace: 11,
        },
        [staleKey]: {
          repoCommonDir: "/repos/sample/.git",
          worktreeRoot: "/stale/worktree",
          workspace: 12,
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
          version: 1,
          workspaceStart: 11,
          assignments: {
            bogus: {
              repoCommonDir: "/repo/.git",
              worktreeRoot: "/repo",
              workspace: 11,
            },
          },
        }),
      ),
    ).toThrow("key does not match");
  });

  it("reuses an existing assignment even if the workspace is currently occupied", () => {
    const worktree = createWorktree();
    const registry: WorkspaceRegistry = {
      version: 1,
      workspaceStart: 11,
      assignments: {
        [worktree.key]: {
          repoCommonDir: worktree.repoCommonDir,
          worktreeRoot: worktree.worktreeRoot,
          workspace: 17,
        },
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

    expect(result.workspace).toBe(17);
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

    expect(result.workspace).toBe(13);
    expect(fs.files.get("/state/hypr-workspaces/assignments.json")).toContain('"workspace": 13');
  });

  it("builds a safe dispatch command for arbitrary shell payloads", () => {
    const dispatch = buildSpawnDispatch({
      workspace: 12,
      cwd: "/repo/path/that's/fine",
      command: `echo 'hello' && pnpm run dev`,
      silent: true,
    });

    expect(dispatch).toContain("[workspace 12 silent]");
    expect(dispatch).toContain(quoteShellArg("/repo/path/that's/fine"));
    expect(dispatch).toContain(quoteShellArg(`echo 'hello' && pnpm run dev`));
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

  it("where ensures an assignment and prints only the workspace number", () => {
    const { deps, dispatches, outputs } = createCliDeps({
      occupiedWorkspaces: new Set([11]),
    });

    const result = runCli(["where"], deps);

    expect(result.exitCode).toBe(0);
    expect(dispatches).toEqual([]);
    expect(outputs.stdout).toEqual(["12"]);
  });

  it("goto switches to the assigned workspace", () => {
    const { deps, dispatches, outputs } = createCliDeps({});

    const result = runCli(["goto"], deps);

    expect(result.exitCode).toBe(0);
    expect(dispatches).toEqual(["workspace:11"]);
    expect(outputs.stdout).toEqual(["11"]);
  });

  it("spawn switches first and then launches on the assigned workspace", () => {
    const { deps, dispatches, outputs, worktree } = createCliDeps({});

    const result = runCli(["spawn", "--", "pnpm run dev:desktop:wayland"], deps);

    expect(result.exitCode).toBe(0);
    expect(dispatches[0]).toBe("workspace:11");
    expect(dispatches[1]).toContain("exec:[workspace 11]");
    expect(dispatches[1]).toContain(quoteShellArg(worktree.cwd));
    expect(outputs.stdout).toEqual([`workspace=11 worktree=${worktree.worktreeRoot}`]);
  });

  it("spawn --silent launches without switching first", () => {
    const { deps, dispatches } = createCliDeps({});

    const result = runCli(["spawn", "--silent", "--", "echo hi"], deps);

    expect(result.exitCode).toBe(0);
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toContain("exec:[workspace 11 silent]");
  });

  it("fails clearly outside Hyprland", () => {
    const { deps, outputs } = createCliDeps({
      env: { HYPRLAND_INSTANCE_SIGNATURE: "" },
    });

    const result = runCli(["where"], deps);

    expect(result.exitCode).toBe(1);
    expect(outputs.stderr[0]).toContain("Hyprland does not appear to be running");
  });

  it("keeps the caller cwd for spawn instead of forcing the worktree root", () => {
    const worktree = createWorktree({
      cwd: "/repos/sample/apps/web",
      worktreeRoot: "/repos/sample",
    });
    const { deps, dispatches } = createCliDeps({ argvWorktree: worktree });

    runCli(["spawn", "--", "pnpm run dev"], deps);

    expect(dispatches[1]).toContain(quoteShellArg("/repos/sample/apps/web"));
    expect(dispatches[1]).not.toContain(quoteShellArg(worktree.worktreeRoot));
  });
});
