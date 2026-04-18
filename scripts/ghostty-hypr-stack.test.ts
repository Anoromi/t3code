import { describe, expect, it } from "vitest";

import {
  runCli as runGhosttyCli,
  resolveStateFilePath as resolveGhosttyStateFilePath,
  type HyprClient,
} from "./ghostty-worktree.ts";
import {
  createAssignmentKey,
  resolvePidFilePath,
  runCli as runHyprCli,
  serializeRegistry as serializeHyprRegistry,
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

  unlinkSync = (path: string): void => {
    if (!this.files.delete(path)) {
      const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
  };
}

const worktree: ResolvedWorktree = {
  cwd: "/repos/sample-feature/apps/web",
  repoCommonDir: "/repos/sample/.git",
  worktreeRoot: "/repos/sample-feature",
  key: createAssignmentKey("/repos/sample/.git", "/repos/sample-feature"),
};

function createStackHarness() {
  const fs = new MemoryFileSystem();
  const env = {
    HYPRLAND_INSTANCE_SIGNATURE: "sig",
    XDG_STATE_HOME: "/state",
  };
  const outputs = { stdout: [] as string[], stderr: [] as string[] };
  const dispatches: string[] = [];
  const launches: string[] = [];
  let nextPid = 4321;
  let managedClient: HyprClient | null = null;
  const pidFilePath = resolvePidFilePath(env, worktree.key, "/home/tester");

  const commonDeps = {
    cwd: () => worktree.cwd,
    env,
    fileSystem: fs,
    homeDir: "/home/tester",
    resolveWorktreeFromCwd: () => worktree,
    resolveGitCommonDirForWorktree: (worktreeRoot: string) => {
      if (worktreeRoot === worktree.worktreeRoot) {
        return worktree.repoCommonDir;
      }
      return "/repos/other/.git";
    },
    sleep: async () => undefined,
    stdout: (line: string) => {
      outputs.stdout.push(line);
    },
    stderr: (line: string) => {
      outputs.stderr.push(line);
    },
  };

  return {
    dispatches,
    fs,
    launches,
    outputs,
    ghosttyDeps: {
      ...commonDeps,
      listClients: () => (managedClient ? [managedClient] : []),
      dispatchWorkspace: (workspace: number) => {
        dispatches.push(`ghostty-workspace:${String(workspace)}`);
      },
      dispatchFocusWindow: (address: string) => {
        dispatches.push(`ghostty-focus:${address}`);
      },
      launchGhostty: (command: string) => {
        launches.push(command);
        const className = command.match(/dev\.t3tools\.t3code\.ghostty\.w[0-9a-f]{12}/)?.[0];
        if (className) {
          managedClient = {
            address: "0xabc",
            workspace: 17,
            pid: nextPid,
            className,
            title: "Ghostty sample:sample-feature",
          };
        }
        nextPid += 1;
        return 17;
      },
      assertGhosttyAvailable: () => undefined,
    },
    hyprDeps: {
      ...commonDeps,
      listOccupiedWorkspaces: () => new Set<number>(),
      dispatchWorkspace: (workspace: number) => {
        dispatches.push(`hypr-workspace:${String(workspace)}`);
      },
      dispatchExec: (command: string) => {
        dispatches.push(`hypr-exec:${command}`);
        fs.writeFileSync(pidFilePath, `${String(nextPid)}\n`);
        nextPid += 1;
      },
      isProcessAlive: () => false,
      listChildPids: () => [],
      killProcess: () => undefined,
    },
  };
}

describe("ghostty + hypr worktree stack", () => {
  it("allocates a managed workspace and opens/focuses one managed Ghostty per worktree", async () => {
    const harness = createStackHarness();

    const hyprResult = await runHyprCli(["spawn", "--", "echo ok"], harness.hyprDeps);
    expect(hyprResult.exitCode).toBe(0);
    expect(harness.dispatches[0]).toBe("hypr-workspace:11");
    expect(harness.dispatches[1]).toContain("hypr-exec:");
    expect(harness.dispatches[1]).toContain("echo ok");

    const firstOpen = await runGhosttyCli([], harness.ghosttyDeps);
    const secondOpen = await runGhosttyCli([], harness.ghosttyDeps);

    expect(firstOpen.exitCode).toBe(0);
    expect(secondOpen.exitCode).toBe(0);
    expect(harness.launches).toHaveLength(1);
    expect(harness.launches[0]).toContain('--working-directory="$3"');
    expect(harness.launches[0]).toContain("dev.t3tools.t3code.ghostty.w");
    expect(harness.dispatches).toContain("ghostty-focus:0xabc");
  });

  it("returns actionable failures for malformed registries and unavailable Ghostty", async () => {
    const malformed = createStackHarness();
    malformed.fs.writeFileSync(
      resolveGhosttyStateFilePath(malformed.ghosttyDeps.env, "/home/tester"),
      "{bad",
    );
    const malformedResult = await runGhosttyCli([], malformed.ghosttyDeps);

    expect(malformedResult.exitCode).toBe(1);
    expect(malformedResult.stderr.join("\n")).toContain("Malformed ghostty-worktree registry JSON");

    const unavailable = createStackHarness();
    const unavailableResult = await runGhosttyCli([], {
      ...unavailable.ghosttyDeps,
      assertGhosttyAvailable: () => {
        throw new Error("Ghostty does not appear to be installed in PATH.");
      },
    });

    expect(unavailableResult.exitCode).toBe(1);
    expect(unavailableResult.stderr.join("\n")).toContain(
      "Ghostty does not appear to be installed",
    );
  });

  it("reports malformed Hypr workspace registries without launching", async () => {
    const harness = createStackHarness();
    const registry: WorkspaceRegistry = {
      version: 2,
      workspaceStart: 11,
      assignments: {},
    };
    harness.fs.writeFileSync(
      "/state/hypr-workspaces/assignments.json",
      serializeHyprRegistry(registry),
    );
    harness.fs.writeFileSync("/state/hypr-workspaces/assignments.json", "{bad");

    const result = await runHyprCli(["spawn", "--", "echo ok"], harness.hyprDeps);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toContain("Malformed hypr-workspaces registry JSON");
    expect(harness.dispatches).toEqual([]);
  });
});
