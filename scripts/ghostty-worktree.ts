#!/usr/bin/env node
// @effect-diagnostics globalTimers:off nodeBuiltinImport:off
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as NodeFs from "node:fs";
import { homedir } from "node:os";
import * as NodePath from "node:path";

import {
  createAssignmentKey,
  normalizePath,
  resolveGitCommonDirForWorktree,
  resolveWorktreeFromCwd,
  type ResolvedWorktree,
} from "./lib/worktree.ts";

const CLASS_PREFIX = "dev.t3tools.t3code.ghostty";
const POLL_ATTEMPTS = 30;

export interface GhosttyAssignment {
  readonly repoCommonDir: string;
  readonly worktreeRoot: string;
  readonly pid: number;
  readonly className: string;
  readonly title: string;
}

interface Registry {
  readonly version: 1;
  readonly assignments: Record<string, GhosttyAssignment>;
}

interface HyprClient {
  readonly address: string;
  readonly workspace: number;
  readonly pid: number;
  readonly className: string;
}

export function resolveStateFilePath(env: NodeJS.ProcessEnv, home = homedir()): string {
  return NodePath.join(
    env.XDG_STATE_HOME?.trim() || NodePath.join(home, ".local", "state"),
    "ghostty-worktree",
    "assignments.json",
  );
}

export function createManagedClassName(worktreeKey: string): string {
  return `${CLASS_PREFIX}.w${createHash("sha256").update(worktreeKey).digest("hex").slice(0, 12)}`;
}

export function createManagedTitle(worktree: ResolvedWorktree): string {
  const repo = NodePath.basename(NodePath.dirname(worktree.repoCommonDir));
  const worktreeName = NodePath.basename(worktree.worktreeRoot);
  return repo === worktreeName ? `Ghostty ${repo}` : `Ghostty ${repo}:${worktreeName}`;
}

export function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildGhosttyLaunchCommand(input: {
  readonly className: string;
  readonly cwd: string;
  readonly title: string;
  readonly execCommand: string | null;
}): string {
  const launcher = input.execCommand
    ? 'exec ghostty --gtk-single-instance=false --class="$1" --title="$2" --working-directory="$3" -e sh -lc "$4"'
    : 'exec ghostty --gtk-single-instance=false --class="$1" --title="$2" --working-directory="$3"';
  return [
    "sh -lc",
    quoteShellArg(launcher),
    "ghostty-worktree",
    quoteShellArg(input.className),
    quoteShellArg(input.title),
    quoteShellArg(input.cwd),
    ...(input.execCommand ? [quoteShellArg(input.execCommand)] : []),
  ].join(" ");
}

export function parseCliArgs(argv: readonly string[]): {
  readonly mode: "open" | "list-open";
  readonly execCommand: string | null;
} {
  if (argv.length === 0) return { mode: "open", execCommand: null };
  if (argv.length === 1 && argv[0] === "list-open") return { mode: "list-open", execCommand: null };
  if (argv.length === 2 && argv[0] === "--exec" && argv[1]?.trim()) {
    return { mode: "open", execCommand: argv[1].trim() };
  }
  throw new Error("ghostty-worktree only accepts no args, 'list-open', or '--exec <command>'.");
}

function readRegistry(path: string): Registry {
  if (!NodeFs.existsSync(path)) return { version: 1, assignments: {} };
  const parsed: unknown = JSON.parse(NodeFs.readFileSync(path, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("assignments" in parsed) ||
    typeof parsed.assignments !== "object" ||
    parsed.assignments === null
  ) {
    throw new Error("Malformed ghostty-worktree registry.");
  }
  return parsed as Registry;
}

function writeRegistry(path: string, registry: Registry): void {
  NodeFs.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFs.writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`);
}

function command(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function clients(): HyprClient[] {
  const parsed: unknown = JSON.parse(command("hyprctl", ["-j", "clients"]));
  if (!Array.isArray(parsed)) throw new Error("hyprctl returned an invalid client list.");
  return parsed.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const client = value as Record<string, unknown>;
    const workspace = client.workspace as Record<string, unknown> | undefined;
    return typeof client.address === "string" &&
      typeof client.pid === "number" &&
      typeof client.class === "string" &&
      typeof workspace?.id === "number"
      ? [
          {
            address: client.address,
            pid: client.pid,
            className: client.class,
            workspace: workspace.id,
          },
        ]
      : [];
  });
}

function liveClient(
  assignment: GhosttyAssignment,
  values: readonly HyprClient[],
): HyprClient | null {
  return (
    values.find(
      (client) => client.className === assignment.className && client.pid === assignment.pid,
    ) ??
    values.find((client) => client.className === assignment.className) ??
    null
  );
}

function focus(client: HyprClient): void {
  command("hyprctl", ["dispatch", "workspace", String(client.workspace)]);
  command("hyprctl", ["dispatch", "focuswindow", `address:${client.address}`]);
}

function prune(registry: Registry): Registry {
  const assignments: Record<string, GhosttyAssignment> = {};
  for (const assignment of Object.values(registry.assignments)) {
    try {
      if (
        normalizePath(resolveGitCommonDirForWorktree(assignment.worktreeRoot)) !==
        normalizePath(assignment.repoCommonDir)
      )
        continue;
      assignments[createAssignmentKey(assignment.repoCommonDir, assignment.worktreeRoot)] =
        assignment;
    } catch {
      // Removed worktrees are intentionally discarded.
    }
  }
  return { version: 1, assignments };
}

function spawnGhostty(commandLine: string): void {
  const result = spawnSync(
    "hyprnav",
    ["spawn", "--print-workspace-id", "rand", "--", "sh", "-lc", commandLine],
    {
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status === 0) return;
  if (
    result.stderr.includes("request_failed: connecting to") &&
    result.stderr.includes("/spawn.sock") &&
    Number.isSafeInteger(Number(result.stdout.trim()))
  ) {
    command("hyprctl", ["dispatch", "workspace", result.stdout.trim()]);
    command("hyprctl", ["dispatch", "exec", commandLine]);
    return;
  }
  throw new Error(
    result.stderr.trim() || `hyprnav spawn failed with status ${String(result.status)}.`,
  );
}

async function waitForClient(className: string): Promise<HyprClient> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const match = clients().find((client) => client.className === className);
    if (match) return match;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Ghostty class ${className}.`);
}

export async function runCli(argv: readonly string[]): Promise<number> {
  try {
    if (process.platform !== "linux" || !process.env.HYPRLAND_INSTANCE_SIGNATURE?.trim()) {
      throw new Error("Hyprland does not appear to be running in this environment.");
    }
    const args = parseCliArgs(argv);
    const statePath = resolveStateFilePath(process.env);
    const registry = prune(readRegistry(statePath));
    const openClients = clients();
    if (args.mode === "list-open") {
      const assignments: Record<string, GhosttyAssignment> = {};
      const open: Array<{ readonly worktreePath: string }> = [];
      for (const assignment of Object.values(registry.assignments)) {
        const client = liveClient(assignment, openClients);
        if (!client) continue;
        const recovered = { ...assignment, pid: client.pid };
        assignments[createAssignmentKey(recovered.repoCommonDir, recovered.worktreeRoot)] =
          recovered;
        open.push({ worktreePath: recovered.worktreeRoot });
      }
      writeRegistry(statePath, { version: 1, assignments });
      process.stdout.write(`${JSON.stringify(open)}\n`);
      return 0;
    }
    const ghostty = spawnSync("ghostty", ["+version"], { stdio: "ignore" });
    if (ghostty.error || ghostty.status !== 0)
      throw new Error("Ghostty does not appear to be installed in PATH.");
    const worktree = resolveWorktreeFromCwd(process.cwd());
    const existing = registry.assignments[worktree.key];
    const existingClient = existing ? liveClient(existing, openClients) : null;
    if (existing && existingClient) {
      const recovered = { ...existing, pid: existingClient.pid };
      writeRegistry(statePath, {
        version: 1,
        assignments: { ...registry.assignments, [worktree.key]: recovered },
      });
      focus(existingClient);
      process.stdout.write(
        `pid=${String(recovered.pid)} workspace=${String(existingClient.workspace)} worktree=${worktree.worktreeRoot}\n`,
      );
      return 0;
    }
    const className = createManagedClassName(worktree.key);
    spawnGhostty(
      buildGhosttyLaunchCommand({
        className,
        cwd: worktree.cwd,
        title: createManagedTitle(worktree),
        execCommand: args.execCommand,
      }),
    );
    const client = await waitForClient(className);
    const assignment: GhosttyAssignment = {
      repoCommonDir: worktree.repoCommonDir,
      worktreeRoot: worktree.worktreeRoot,
      pid: client.pid,
      className,
      title: createManagedTitle(worktree),
    };
    writeRegistry(statePath, {
      version: 1,
      assignments: { ...registry.assignments, [worktree.key]: assignment },
    });
    focus(client);
    process.stdout.write(
      `pid=${String(client.pid)} workspace=${String(client.workspace)} worktree=${worktree.worktreeRoot}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `[ghostty-worktree] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
