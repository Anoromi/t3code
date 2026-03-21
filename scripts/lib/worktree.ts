import { execFileSync } from "node:child_process";
import * as Path from "node:path";

export interface ResolvedWorktree {
  readonly cwd: string;
  readonly repoCommonDir: string;
  readonly worktreeRoot: string;
  readonly key: string;
}

export function normalizePath(value: string): string {
  return Path.resolve(value);
}

function runGitTextCommand(args: ReadonlyArray<string>, cwd?: string): string {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(
      `Command failed: git ${args.join(" ")}${cwd ? ` (cwd=${cwd})` : ""}: ${String(error)}`,
      {
        cause: error,
      },
    );
  }
}

export function createAssignmentKey(repoCommonDir: string, worktreeRoot: string): string {
  return `${normalizePath(repoCommonDir)}::${normalizePath(worktreeRoot)}`;
}

export function resolveWorktreeFromCwd(cwd: string): ResolvedWorktree {
  const worktreeRoot = normalizePath(runGitTextCommand(["rev-parse", "--show-toplevel"], cwd));
  const repoCommonDir = normalizePath(
    runGitTextCommand(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd),
  );

  return {
    cwd: normalizePath(cwd),
    repoCommonDir,
    worktreeRoot,
    key: createAssignmentKey(repoCommonDir, worktreeRoot),
  };
}

export function resolveGitCommonDirForWorktree(worktreeRoot: string): string {
  return normalizePath(
    runGitTextCommand(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktreeRoot),
  );
}
