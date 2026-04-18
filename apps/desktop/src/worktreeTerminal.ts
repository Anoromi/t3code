import * as ChildProcess from "node:child_process";
import * as Path from "node:path";

const WORKTREE_ASSIGNMENT_PATTERN = /^pid=\d+\s+workspace=\d+\s+worktree=(.+)$/u;
const TMUX_EXEC_COMMAND = "exec tmux";

export interface OpenWorktreeTerminalInput {
  readonly cwd: string;
  readonly rootDir: string;
}

export interface OpenWorktreeTerminalResult {
  readonly worktreePath: string;
}

export interface ListOpenWorktreeTerminalsInput {
  readonly rootDir: string;
}

export interface OpenWorktreeTerminalEntry {
  readonly worktreePath: string;
}

interface WorktreeTerminalLauncherDeps {
  readonly spawn: typeof ChildProcess.spawn;
}

function formatExitFailure(input: {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}): string {
  if (input.stderr.length > 0) {
    return input.stderr;
  }
  if (input.signal) {
    return `launcher exited with signal ${input.signal}`;
  }
  if (typeof input.code === "number") {
    return `launcher exited with code ${String(input.code)}`;
  }
  return "launcher exited unexpectedly";
}

export function extractWorktreePathFromStdout(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/u)) {
    const normalized = line.trim();
    if (normalized.length === 0) {
      continue;
    }
    const match = WORKTREE_ASSIGNMENT_PATTERN.exec(normalized);
    if (!match) {
      return null;
    }
    const worktreePath = match[1]?.trim();
    return worktreePath && worktreePath.length > 0 ? worktreePath : null;
  }

  return null;
}

export function parseOpenWorktreeTerminalEntries(stdout: string): OpenWorktreeTerminalEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Malformed open worktree terminal list JSON: ${String(error)}`, {
      cause: error,
    });
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Malformed open worktree terminal list JSON: expected an array.");
  }

  return parsed.map((entry, index) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { worktreePath?: unknown }).worktreePath !== "string" ||
      (entry as { worktreePath: string }).worktreePath.trim().length === 0
    ) {
      throw new Error(
        `Malformed open worktree terminal list JSON: invalid worktreePath at index ${String(index)}.`,
      );
    }

    return {
      worktreePath: (entry as { worktreePath: string }).worktreePath.trim(),
    };
  });
}

export class WorktreeTerminalLauncher {
  private readonly deps: WorktreeTerminalLauncherDeps;

  constructor(deps: WorktreeTerminalLauncherDeps) {
    this.deps = deps;
  }

  async open(input: OpenWorktreeTerminalInput): Promise<OpenWorktreeTerminalResult> {
    const cwd = input.cwd.trim();
    if (cwd.length === 0) {
      throw new Error("Worktree terminal launch requires a valid working directory.");
    }

    const child = this.deps.spawn(
      "bun",
      [Path.join(input.rootDir, "scripts", "ghostty-worktree.ts"), "--exec", TMUX_EXEC_COMMAND],
      {
        cwd,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    let settled = false;
    let stdoutBuffer = "";
    const stderrChunks: string[] = [];

    return await new Promise<OpenWorktreeTerminalResult>((resolve, reject) => {
      const settle = (result: OpenWorktreeTerminalResult | null, error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          reject(error);
          return;
        }
        if (!result) {
          reject(new Error("Worktree terminal launch did not produce a worktree path."));
          return;
        }
        resolve(result);
      };

      const tryParseWorktreePath = () => {
        const worktreePath = extractWorktreePathFromStdout(stdoutBuffer);
        if (worktreePath === null) {
          return;
        }
        settle({ worktreePath });
      };

      child.stdout?.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        if (!settled) {
          tryParseWorktreePath();
        }
      });

      child.stderr?.on("data", (chunk: string) => {
        stderrChunks.push(chunk);
      });

      child.once("error", (error) => {
        settle(
          null,
          new Error(`Failed to start worktree terminal launcher: ${error.message}`, {
            cause: error,
          }),
        );
      });

      child.once("exit", (code, signal) => {
        if (!settled) {
          const parsedWorktreePath = extractWorktreePathFromStdout(stdoutBuffer);
          if (parsedWorktreePath !== null && (code === 0 || code === null)) {
            settle({ worktreePath: parsedWorktreePath });
            return;
          }

          settle(
            null,
            new Error(
              `Worktree terminal launcher exited before launch completed: ${formatExitFailure({
                code,
                signal,
                stderr: stderrChunks.join("").trim(),
              })}`,
            ),
          );
        }
      });
    });
  }

  async listOpen(
    input: ListOpenWorktreeTerminalsInput,
  ): Promise<ReadonlyArray<OpenWorktreeTerminalEntry>> {
    const child = this.deps.spawn(
      "bun",
      [Path.join(input.rootDir, "scripts", "ghostty-worktree.ts"), "list-open"],
      {
        cwd: input.rootDir,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    let stdoutBuffer = "";
    const stderrChunks: string[] = [];

    return await new Promise<ReadonlyArray<OpenWorktreeTerminalEntry>>((resolve, reject) => {
      child.stdout?.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
      });

      child.stderr?.on("data", (chunk: string) => {
        stderrChunks.push(chunk);
      });

      child.once("error", (error) => {
        reject(
          new Error(`Failed to start worktree terminal query: ${error.message}`, {
            cause: error,
          }),
        );
      });

      child.once("exit", (code, signal) => {
        if (code !== 0) {
          reject(
            new Error(
              `Worktree terminal query exited before completion: ${formatExitFailure({
                code,
                signal,
                stderr: stderrChunks.join("").trim(),
              })}`,
            ),
          );
          return;
        }

        try {
          resolve(parseOpenWorktreeTerminalEntries(stdoutBuffer));
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}

export function createWorktreeTerminalLauncher(): WorktreeTerminalLauncher {
  return new WorktreeTerminalLauncher({
    spawn: ChildProcess.spawn,
  });
}
