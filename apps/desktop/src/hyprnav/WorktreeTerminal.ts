// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const ASSIGNMENT = /^pid=\d+\s+workspace=\d+\s+worktree=(.+)$/u;

export class WorktreeTerminalCommandError extends Schema.TaggedErrorClass<WorktreeTerminalCommandError>()(
  "WorktreeTerminalCommandError",
  { operation: Schema.Literals(["open", "list"]), cause: Schema.Defect() },
) {}

export function extractWorktreePathFromStdout(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const match = ASSIGNMENT.exec(line.trim());
    return match?.[1]?.trim() || null;
  }
  return null;
}

export function parseOpenWorktreeTerminalEntries(
  stdout: string,
): ReadonlyArray<{ readonly worktreePath: string }> {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("Expected an array of worktree terminals.");
  return parsed.map((entry, index) => {
    const worktreePath =
      typeof entry === "object" && entry !== null && "worktreePath" in entry
        ? entry.worktreePath
        : null;
    if (typeof worktreePath !== "string" || worktreePath.trim().length === 0) {
      throw new Error(`Invalid worktree path at index ${String(index)}.`);
    }
    return { worktreePath: worktreePath.trim() };
  });
}

interface LauncherOptions {
  readonly spawn?: typeof NodeChildProcess.spawn;
  readonly bunExecutable?: string;
  readonly runtimeEnv?: NodeJS.ProcessEnv;
}

export class WorktreeTerminalLauncher {
  private readonly spawn: typeof NodeChildProcess.spawn;
  private readonly bunExecutable: string;
  private readonly runtimeEnv: NodeJS.ProcessEnv;

  constructor(options: LauncherOptions = {}) {
    this.spawn = options.spawn ?? NodeChildProcess.spawn;
    this.bunExecutable =
      (options.bunExecutable ?? process.env.T3CODE_BUN_EXECUTABLE?.trim()) || "bun";
    this.runtimeEnv = options.runtimeEnv ?? process.env;
  }

  open(input: {
    readonly cwd: string;
    readonly rootDir: string;
  }): Promise<{ readonly worktreePath: string }> {
    const cwd = input.cwd.trim();
    if (!cwd)
      return Promise.reject(
        new Error("Worktree terminal launch requires a valid working directory."),
      );
    const child = this.spawn(
      this.bunExecutable,
      [NodePath.join(input.rootDir, "scripts", "ghostty-worktree.ts"), "--exec", "exec tmux"],
      { cwd, env: { ...this.runtimeEnv }, stdio: ["ignore", "pipe", "pipe"] },
    );
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        const worktreePath = extractWorktreePathFromStdout(stdout);
        if (worktreePath) {
          settled = true;
          resolve({ worktreePath });
        } else if (error) {
          settled = true;
          reject(error);
        }
      };
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        finish();
      });
      child.stderr?.on("data", (chunk: string) => (stderr += chunk));
      child.once("error", (error) => finish(error));
      child.once("exit", (code, signal) =>
        finish(
          new Error(
            stderr.trim() ||
              (signal
                ? `Launcher exited with signal ${signal}.`
                : `Launcher exited with code ${String(code)}.`),
          ),
        ),
      );
    });
  }

  list(rootDir: string): Promise<ReadonlyArray<{ readonly worktreePath: string }>> {
    const child = this.spawn(
      this.bunExecutable,
      [NodePath.join(rootDir, "scripts", "ghostty-worktree.ts"), "list-open"],
      {
        cwd: rootDir,
        env: { ...this.runtimeEnv },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => (stdout += chunk));
      child.stderr?.on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== 0)
          return reject(new Error(stderr.trim() || `Launcher exited with code ${String(code)}.`));
        try {
          resolve(parseOpenWorktreeTerminalEntries(stdout));
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}

export class WorktreeTerminal extends Context.Service<
  WorktreeTerminal,
  {
    readonly open: (
      cwd: string,
    ) => Effect.Effect<{ readonly worktreePath: string }, WorktreeTerminalCommandError>;
    readonly list: Effect.Effect<
      ReadonlyArray<{ readonly worktreePath: string }>,
      WorktreeTerminalCommandError
    >;
  }
>()("@t3tools/desktop/hyprnav/WorktreeTerminal") {}

export const layer = Layer.effect(
  WorktreeTerminal,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const launcher = new WorktreeTerminalLauncher();
    const launcherRoot = environment.isPackaged ? environment.resourcesPath : environment.appRoot;
    return WorktreeTerminal.of({
      open: (cwd) =>
        Effect.tryPromise({
          try: () => launcher.open({ cwd, rootDir: launcherRoot }),
          catch: (cause) => new WorktreeTerminalCommandError({ operation: "open", cause }),
        }),
      list: Effect.tryPromise({
        try: () => launcher.list(launcherRoot),
        catch: (cause) => new WorktreeTerminalCommandError({ operation: "list", cause }),
      }),
    });
  }),
);
