import { describe, expect, it } from "vitest";

import {
  buildGhosttyLaunchCommand,
  createManagedClassName,
  createManagedTitle,
  findManagedClientByClassName,
  findManagedClient,
  parseCliArgs,
  parseRegistry,
  pruneAssignments,
  quoteShellArg,
  resolveStateFilePath,
  runCli,
  serializeRegistry,
  type GhosttyAssignment,
  type GhosttyRegistry,
  type HyprClient,
} from "./ghostty-worktree.ts";
import { createAssignmentKey, type ResolvedWorktree } from "./lib/worktree.ts";

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
  const worktreeRoot = overrides.worktreeRoot ?? "/repos/sample-feature";

  return {
    cwd: overrides.cwd ?? `${worktreeRoot}/apps/web`,
    repoCommonDir,
    worktreeRoot,
    key: overrides.key ?? createAssignmentKey(repoCommonDir, worktreeRoot),
  };
}

function createAssignment(
  worktree: ResolvedWorktree,
  overrides: Partial<GhosttyAssignment> = {},
): GhosttyAssignment {
  return {
    repoCommonDir: worktree.repoCommonDir,
    worktreeRoot: worktree.worktreeRoot,
    pid: overrides.pid ?? 3210,
    className: overrides.className ?? createManagedClassName(worktree.key),
    title: overrides.title ?? createManagedTitle(worktree),
  };
}

function createClient(overrides: Partial<HyprClient> = {}): HyprClient {
  return {
    address: overrides.address ?? "0x1234",
    workspace: overrides.workspace ?? 1,
    pid: overrides.pid ?? 3210,
    className: overrides.className ?? "dev.t3tools.t3code.ghostty.deadbeef1234",
    title: overrides.title ?? "Ghostty sample:sample-feature",
  };
}

function createCliDeps(input: {
  readonly argvWorktree?: ResolvedWorktree;
  readonly clients?: ReadonlyArray<ReadonlyArray<HyprClient>>;
  readonly registry?: GhosttyRegistry;
  readonly env?: NodeJS.ProcessEnv;
  readonly ghosttyAvailable?: boolean;
}) {
  const fs = new MemoryFileSystem();
  const outputs = { stdout: [] as Array<string>, stderr: [] as Array<string> };
  const dispatches: Array<string> = [];
  const worktree = input.argvWorktree ?? createWorktree();
  const stateFilePath = resolveStateFilePath({ XDG_STATE_HOME: "/state" }, "/home/tester");

  if (input.registry) {
    fs.files.set(stateFilePath, serializeRegistry(input.registry));
  }

  let clientCallCount = 0;

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
        if (worktreeRoot === "/stale/worktree") {
          return "/repos/other/.git";
        }

        if (worktreeRoot === worktree.worktreeRoot) {
          return worktree.repoCommonDir;
        }

        return "/repos/other/.git";
      },
      listClients: () => {
        const snapshots = input.clients ?? [];
        const snapshot =
          snapshots[Math.min(clientCallCount, Math.max(snapshots.length - 1, 0))] ?? [];
        clientCallCount += 1;
        return snapshot;
      },
      dispatchWorkspace: (workspace: number) => {
        dispatches.push(`workspace:${String(workspace)}`);
      },
      dispatchFocusWindow: (address: string) => {
        dispatches.push(`focus:${address}`);
      },
      dispatchMoveToWorkspace: (workspace: number, address: string) => {
        dispatches.push(`move:${String(workspace)}:${address}`);
      },
      dispatchExec: (command: string) => {
        dispatches.push(`exec:${command}`);
      },
      assertGhosttyAvailable: () => {
        if (input.ghosttyAvailable === false) {
          throw new Error("Ghostty does not appear to be installed in PATH.");
        }
      },
      sleep: async () => undefined,
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

describe("ghostty-worktree", () => {
  it("creates stable worktree-bound managed class names", () => {
    const key = createAssignmentKey("/repo/.git", "/repo-worktree");
    expect(createManagedClassName(key)).toBe(createManagedClassName(key));
    expect(createManagedClassName(key)).toMatch(/^dev\.t3tools\.t3code\.ghostty\.w[0-9a-f]{12}$/);
  });

  it("creates a stable managed title from repo and worktree", () => {
    const worktree = createWorktree();
    expect(createManagedTitle(worktree)).toBe("Ghostty sample:sample-feature");
  });

  it("prunes assignments when a worktree no longer resolves to the same common dir", () => {
    const live = createWorktree();
    const staleKey = createAssignmentKey("/repos/sample/.git", "/stale/worktree");
    const registry: GhosttyRegistry = {
      version: 1,
      assignments: {
        [live.key]: createAssignment(live, { pid: 11 }),
        [staleKey]: {
          repoCommonDir: "/repos/sample/.git",
          worktreeRoot: "/stale/worktree",
          pid: 12,
          className: "dev.t3tools.t3code.ghostty.wstale000000",
          title: "Ghostty stale",
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
    expect(() => parseRegistry("{bad-json")).toThrow("Malformed ghostty-worktree registry JSON");
  });

  it("finds a managed client only when pid and class both match", () => {
    const worktree = createWorktree();
    const assignment = createAssignment(worktree, { pid: 200 });
    const client = findManagedClient(
      [
        createClient({ pid: 200, className: "wrong.class" }),
        createClient({ pid: 200, className: assignment.className, address: "0x2222" }),
      ],
      assignment,
    );

    expect(client?.address).toBe("0x2222");
  });

  it("finds a managed client by class name", () => {
    const client = findManagedClientByClassName(
      [createClient({ className: "wrong.class" }), createClient({ className: "good.class" })],
      "good.class",
    );

    expect(client?.className).toBe("good.class");
  });

  it("builds a workspace-targeted Ghostty launch command", () => {
    const command = buildGhosttyLaunchCommand({
      className: "dev.t3tools.t3code.ghostty.abc123",
      cwd: "/repo/path/that's/fine",
      title: "Ghostty sample:feature",
      workspace: 1,
    });

    expect(command).toContain("[workspace 1 silent]");
    expect(command).toContain("sh -lc");
    expect(command).toContain(
      quoteShellArg(
        'exec ghostty --gtk-single-instance=false --class="$1" --title="$2" --working-directory="$3"',
      ),
    );
    expect(command).toContain(quoteShellArg("dev.t3tools.t3code.ghostty.abc123"));
    expect(command).toContain(quoteShellArg("Ghostty sample:feature"));
    expect(command).toContain(quoteShellArg("/repo/path/that's/fine"));
  });

  it("builds a workspace-targeted Ghostty launch command with an exec payload", () => {
    const command = buildGhosttyLaunchCommand({
      className: "dev.t3tools.t3code.ghostty.exec123",
      cwd: "/repo/worktree",
      title: "Ghostty sample:feature",
      workspace: 1,
      execCommand: "env T3CODE_SERVER_URL='ws://127.0.0.1:1234/ws' nvim -c 'CorkDiff t3code'",
    });

    expect(command).toContain(
      'ghostty --gtk-single-instance=false --class="$1" --title="$2" --working-directory="$3" -e sh -lc "$4"',
    );
    expect(command).toContain(
      quoteShellArg("env T3CODE_SERVER_URL='ws://127.0.0.1:1234/ws' nvim -c 'CorkDiff t3code'"),
    );
  });

  it("parses no-arg CLI invocation", () => {
    expect(parseCliArgs([])).toEqual({ execCommand: null });
  });

  it("parses --exec CLI invocation", () => {
    expect(parseCliArgs(["--exec", "nvim -c 'CorkDiff t3code'"])).toEqual({
      execCommand: "nvim -c 'CorkDiff t3code'",
    });
  });

  it("rejects invalid CLI arguments", () => {
    expect(() => parseCliArgs(["--exec"])).toThrow(
      "ghostty-worktree only accepts an optional --exec <command> argument.",
    );
    expect(() => parseCliArgs(["noop"])).toThrow(
      "ghostty-worktree only accepts an optional --exec <command> argument.",
    );
  });

  it("focuses an existing managed Ghostty window", async () => {
    const worktree = createWorktree();
    const assignment = createAssignment(worktree, { pid: 200 });
    const { deps, dispatches, outputs } = createCliDeps({
      argvWorktree: worktree,
      registry: {
        version: 1,
        assignments: {
          [worktree.key]: assignment,
        },
      },
      clients: [[createClient({ pid: 200, className: assignment.className, workspace: 1 })]],
    });

    const result = await runCli([], deps);

    expect(result.exitCode).toBe(0);
    expect(dispatches).toEqual(["workspace:1", "focus:0x1234"]);
    expect(outputs.stdout).toEqual([`pid=200 workspace=1 worktree=${worktree.worktreeRoot}`]);
  });

  it("does not dispatch a new Ghostty launch when focusing an existing managed window", async () => {
    const worktree = createWorktree();
    const assignment = createAssignment(worktree, { pid: 200 });
    const { deps, dispatches } = createCliDeps({
      argvWorktree: worktree,
      registry: {
        version: 1,
        assignments: {
          [worktree.key]: assignment,
        },
      },
      clients: [[createClient({ pid: 200, className: assignment.className, workspace: 1 })]],
    });

    const result = await runCli(
      ["--exec", "env T3CODE_SERVER_URL='ws://127.0.0.1:1234/ws' nvim -c 'CorkDiff t3code'"],
      deps,
    );

    expect(result.exitCode).toBe(0);
    expect(dispatches.some((entry) => entry.startsWith("exec:"))).toBe(false);
  });

  it("follows the existing managed window to its current workspace", async () => {
    const worktree = createWorktree();
    const assignment = createAssignment(worktree, { pid: 200 });
    const { deps, dispatches } = createCliDeps({
      argvWorktree: worktree,
      registry: {
        version: 1,
        assignments: {
          [worktree.key]: assignment,
        },
      },
      clients: [[createClient({ pid: 200, className: assignment.className, workspace: 7 })]],
    });

    await runCli([], deps);

    expect(dispatches).toEqual(["workspace:7", "focus:0x1234"]);
  });

  it("creates a new Ghostty when the saved pid is stale", async () => {
    const worktree = createWorktree();
    const assignment = createAssignment(worktree, { pid: 200 });
    const { deps, dispatches, outputs, fs, stateFilePath } = createCliDeps({
      argvWorktree: worktree,
      registry: {
        version: 1,
        assignments: {
          [worktree.key]: assignment,
        },
      },
      clients: [
        [],
        [],
        [createClient({ pid: 4321, className: createManagedClassName(worktree.key) })],
      ],
    });

    const result = await runCli([], deps);

    expect(result.exitCode).toBe(0);
    expect(dispatches[0]).toContain("exec:[workspace 1 silent]");
    expect(dispatches.slice(1)).toEqual(["workspace:1", "focus:0x1234"]);
    expect(outputs.stdout).toEqual([`pid=4321 workspace=1 worktree=${worktree.worktreeRoot}`]);
    expect(fs.files.get(stateFilePath)).toContain('"pid": 4321');
  });

  it("recovers an existing managed Ghostty by class when the saved pid is stale", async () => {
    const worktree = createWorktree();
    const assignment = createAssignment(worktree, { pid: 200 });
    const { deps, dispatches, fs, stateFilePath } = createCliDeps({
      argvWorktree: worktree,
      registry: {
        version: 1,
        assignments: {
          [worktree.key]: assignment,
        },
      },
      clients: [[createClient({ pid: 4444, className: createManagedClassName(worktree.key) })]],
    });

    await runCli([], deps);

    expect(dispatches).toEqual(["workspace:1", "focus:0x1234"]);
    expect(fs.files.get(stateFilePath)).toContain('"pid": 4444');
  });

  it("launches Ghostty on workspace 1 with the managed class, title, and caller cwd", async () => {
    const worktree = createWorktree({
      cwd: "/repos/sample-feature/apps/server",
    });
    const { deps, dispatches } = createCliDeps({
      argvWorktree: worktree,
      clients: [[createClient({ pid: 4321, className: createManagedClassName(worktree.key) })]],
    });

    await runCli([], deps);

    expect(dispatches[0]).toContain("[workspace 1 silent]");
    expect(dispatches[0]).toContain(createManagedClassName(worktree.key));
    expect(dispatches[0]).toContain(quoteShellArg("/repos/sample-feature/apps/server"));
    expect(dispatches[0]).toContain(quoteShellArg("Ghostty sample:sample-feature"));
  });

  it("moves a newly created terminal to workspace 1 before focusing it", async () => {
    const worktree = createWorktree();
    const { deps, dispatches } = createCliDeps({
      argvWorktree: worktree,
      clients: [
        [
          createClient({
            pid: 4321,
            className: createManagedClassName(worktree.key),
            workspace: 4,
          }),
        ],
      ],
    });

    await runCli([], deps);

    expect(dispatches).toEqual([
      expect.stringContaining("exec:[workspace 1 silent]"),
      "move:1:0x1234",
      "workspace:1",
      "focus:0x1234",
    ]);
  });

  it("fails clearly outside Hyprland", async () => {
    const { deps, outputs } = createCliDeps({
      env: { HYPRLAND_INSTANCE_SIGNATURE: "" },
    });

    const result = await runCli([], deps);

    expect(result.exitCode).toBe(1);
    expect(outputs.stderr[0]).toContain("Hyprland does not appear to be running");
  });

  it("fails clearly when Ghostty is unavailable", async () => {
    const { deps, outputs } = createCliDeps({
      ghosttyAvailable: false,
    });

    const result = await runCli([], deps);

    expect(result.exitCode).toBe(1);
    expect(outputs.stderr[0]).toContain("Ghostty does not appear to be installed");
  });

  it("fails clearly when the spawned window never appears", async () => {
    const { deps, outputs } = createCliDeps({
      clients: [[], [], []],
    });

    const result = await runCli([], deps);

    expect(result.exitCode).toBe(1);
    expect(outputs.stderr[0]).toContain("Timed out waiting for managed Ghostty window for class");
  });
});
