#!/usr/bin/env node

import { createHash } from "node:crypto";
import * as FS from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import * as Path from "node:path";

import {
  createAssignmentKey,
  normalizePath,
  resolveGitCommonDirForWorktree,
  resolveWorktreeFromCwd,
  type ResolvedWorktree,
} from "./lib/worktree.ts";

export const DEFAULT_WORKSPACE_START = 11;
const REGISTRY_VERSION = 2;
const PID_POLL_INTERVAL_MS = 100;
const PID_POLL_TIMEOUT_MS = 5_000;
const PROCESS_TERMINATION_WAIT_MS = 500;

export interface WorkspaceAssignment {
  readonly repoCommonDir: string;
  readonly worktreeRoot: string;
  readonly workspace: number;
  readonly pid: number;
}

export interface WorkspaceRegistry {
  readonly version: 2;
  readonly workspaceStart: number;
  readonly assignments: Record<string, WorkspaceAssignment>;
}

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: ReadonlyArray<string>;
  readonly stderr: ReadonlyArray<string>;
}

interface FileSystemLike {
  readonly existsSync: (path: string) => boolean;
  readonly mkdirSync: (path: string, options?: { recursive?: boolean }) => void;
  readonly readFileSync: (path: string, encoding: "utf8") => string;
  readonly writeFileSync: (path: string, data: string) => void;
  readonly unlinkSync: (path: string) => void;
}

interface CliDeps {
  readonly cwd: () => string;
  readonly env: NodeJS.ProcessEnv;
  readonly fileSystem: FileSystemLike;
  readonly homeDir: string;
  readonly resolveWorktreeFromCwd: (cwd: string) => ResolvedWorktree;
  readonly resolveGitCommonDirForWorktree: (worktreeRoot: string) => string;
  readonly listOccupiedWorkspaces: () => ReadonlySet<number>;
  readonly dispatchWorkspace: (workspace: number) => void;
  readonly dispatchExec: (command: string) => void;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly listChildPids: (pid: number) => ReadonlyArray<number>;
  readonly killProcess: (pid: number, signal: NodeJS.Signals | 0) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export {
  createAssignmentKey,
  resolveGitCommonDirForWorktree,
  resolveWorktreeFromCwd,
  type ResolvedWorktree,
};

export function createEmptyRegistry(
  workspaceStart: number = DEFAULT_WORKSPACE_START,
): WorkspaceRegistry {
  return {
    version: REGISTRY_VERSION,
    workspaceStart,
    assignments: {},
  };
}

export function resolveStateDirPath(env: NodeJS.ProcessEnv, homeDir: string = homedir()): string {
  const configuredStateHome = env.XDG_STATE_HOME?.trim();
  const stateHome =
    configuredStateHome && configuredStateHome.length > 0
      ? configuredStateHome
      : Path.join(homeDir, ".local", "state");

  return Path.join(stateHome, "hypr-workspaces");
}

export function resolveStateFilePath(env: NodeJS.ProcessEnv, homeDir: string = homedir()): string {
  return Path.join(resolveStateDirPath(env, homeDir), "assignments.json");
}

export function createPidFileName(worktreeKey: string): string {
  return `pid-${createHash("sha256").update(worktreeKey).digest("hex").slice(0, 16)}.txt`;
}

export function resolvePidFilePath(
  env: NodeJS.ProcessEnv,
  worktreeKey: string,
  homeDir: string = homedir(),
): string {
  return Path.join(resolveStateDirPath(env, homeDir), createPidFileName(worktreeKey));
}

function ensurePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${label}: expected a positive integer.`);
  }

  return value;
}

function ensureNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: expected a non-negative integer.`);
  }

  return value;
}

function ensureNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${label}: expected a non-empty string.`);
  }

  return normalizePath(value);
}

function parseAssignment(key: string, rawValue: unknown, version: 1 | 2): WorkspaceAssignment {
  if (!isRecord(rawValue)) {
    throw new Error(`Malformed assignment '${key}': expected an object.`);
  }

  const repoCommonDir = ensureNonEmptyString(
    rawValue.repoCommonDir,
    `assignment '${key}'.repoCommonDir`,
  );
  const worktreeRoot = ensureNonEmptyString(
    rawValue.worktreeRoot,
    `assignment '${key}'.worktreeRoot`,
  );
  const workspace = ensurePositiveInteger(rawValue.workspace, `assignment '${key}'.workspace`);
  const pid = version === 1 ? 0 : ensureNonNegativeInteger(rawValue.pid, `assignment '${key}'.pid`);

  const assignment: WorkspaceAssignment = {
    repoCommonDir,
    worktreeRoot,
    workspace,
    pid,
  };

  const expectedKey = createAssignmentKey(assignment.repoCommonDir, assignment.worktreeRoot);
  if (key !== expectedKey) {
    throw new Error(
      `Malformed assignment '${key}': key does not match repoCommonDir/worktreeRoot identity.`,
    );
  }

  return assignment;
}

export function parseRegistry(contents: string): WorkspaceRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Malformed hypr-workspaces registry JSON: ${String(error)}.`, {
      cause: error,
    });
  }

  if (!isRecord(parsed)) {
    throw new Error("Malformed hypr-workspaces registry JSON: expected an object.");
  }

  const version = parsed.version;
  if (version !== 1 && version !== REGISTRY_VERSION) {
    throw new Error(`Unsupported hypr-workspaces registry version: ${String(version)}.`);
  }

  const workspaceStart = ensurePositiveInteger(parsed.workspaceStart, "workspaceStart");
  const rawAssignments = parsed.assignments;
  if (!isRecord(rawAssignments)) {
    throw new Error("Malformed hypr-workspaces registry JSON: assignments must be an object.");
  }

  const assignments: Record<string, WorkspaceAssignment> = {};
  const seenIdentityKeys = new Set<string>();

  for (const [key, rawValue] of Object.entries(rawAssignments)) {
    const assignment = parseAssignment(key, rawValue, version);
    const expectedKey = createAssignmentKey(assignment.repoCommonDir, assignment.worktreeRoot);
    if (seenIdentityKeys.has(expectedKey)) {
      throw new Error(`Duplicate assignment record for '${expectedKey}'.`);
    }

    seenIdentityKeys.add(expectedKey);
    assignments[expectedKey] = assignment;
  }

  return {
    version: REGISTRY_VERSION,
    workspaceStart,
    assignments,
  };
}

export function serializeRegistry(registry: WorkspaceRegistry): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

export function pruneAssignments(
  registry: WorkspaceRegistry,
  resolveGitCommonDirForWorktree: (worktreeRoot: string) => string,
): WorkspaceRegistry {
  const nextAssignments: Record<string, WorkspaceAssignment> = {};

  for (const assignment of Object.values(registry.assignments)) {
    try {
      const resolvedCommonDir = normalizePath(
        resolveGitCommonDirForWorktree(assignment.worktreeRoot),
      );
      if (resolvedCommonDir !== normalizePath(assignment.repoCommonDir)) {
        continue;
      }

      const key = createAssignmentKey(assignment.repoCommonDir, assignment.worktreeRoot);
      nextAssignments[key] = assignment;
    } catch {
      continue;
    }
  }

  return {
    version: REGISTRY_VERSION,
    workspaceStart: registry.workspaceStart,
    assignments: nextAssignments,
  };
}

export function selectWorkspace(input: {
  readonly workspaceStart: number;
  readonly occupiedWorkspaces: ReadonlySet<number>;
  readonly reservedWorkspaces: ReadonlySet<number>;
}): number {
  for (let workspace = input.workspaceStart; workspace < 100_000; workspace += 1) {
    if (input.occupiedWorkspaces.has(workspace)) continue;
    if (input.reservedWorkspaces.has(workspace)) continue;
    return workspace;
  }

  throw new Error("No allocatable Hyprland workspace found.");
}

export function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildShellLaunchCommand(cwd: string, command: string): string {
  return [
    "sh",
    "-lc",
    quoteShellArg('cd "$1" && exec sh -lc "$2"'),
    "hypr-worktree",
    quoteShellArg(cwd),
    quoteShellArg(command),
  ].join(" ");
}

export function buildManagedShellLaunchCommand(input: {
  readonly cwd: string;
  readonly command: string;
  readonly pidFilePath: string;
}): string {
  return [
    "sh",
    "-lc",
    quoteShellArg(
      'cd "$1"; pidfile="$2"; rm -f "$pidfile"; sh -lc "$3" & child=$!; printf "%s\\n" "$child" >"$pidfile"; wait "$child"',
    ),
    "hypr-worktree",
    quoteShellArg(input.cwd),
    quoteShellArg(input.pidFilePath),
    quoteShellArg(input.command),
  ].join(" ");
}

export function buildSpawnDispatch(input: {
  readonly workspace: number;
  readonly cwd: string;
  readonly command: string;
  readonly silent: boolean;
  readonly pidFilePath: string;
}): string {
  const workspaceRule = input.silent
    ? `[workspace ${String(input.workspace)} silent]`
    : `[workspace ${String(input.workspace)}]`;

  return `${workspaceRule} ${buildManagedShellLaunchCommand({
    cwd: input.cwd,
    command: input.command,
    pidFilePath: input.pidFilePath,
  })}`;
}

export function resolveCommandString(args: ReadonlyArray<string>): string {
  const separatorIndex = args.indexOf("--");
  const commandArgs = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : args;
  const command = commandArgs.join(" ").trim();

  if (command.length === 0) {
    throw new Error("Missing command. Pass a shell command after '--'.");
  }

  return command;
}

export function resolveSpawnOptions(args: ReadonlyArray<string>): {
  readonly silent: boolean;
  readonly remainingArgs: ReadonlyArray<string>;
} {
  let silent = false;
  const remaining: Array<string> = [];

  for (const arg of args) {
    if (arg === "--silent") {
      silent = true;
      continue;
    }

    remaining.push(arg);
  }

  return { silent, remainingArgs: remaining };
}

function defaultFileSystem(): FileSystemLike {
  return {
    existsSync: FS.existsSync,
    mkdirSync: FS.mkdirSync,
    readFileSync: FS.readFileSync,
    writeFileSync: FS.writeFileSync,
    unlinkSync: FS.unlinkSync,
  };
}

function runTextCommand(command: string, args: ReadonlyArray<string>, cwd?: string): string {
  try {
    return execFileSync(command, [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}${cwd ? ` (cwd=${cwd})` : ""}: ${String(error)}`,
      {
        cause: error,
      },
    );
  }
}

export function listOccupiedWorkspaces(): ReadonlySet<number> {
  const raw = runTextCommand("hyprctl", ["-j", "workspaces"]);
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse 'hyprctl -j workspaces': ${String(error)}.`, {
      cause: error,
    });
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Unexpected 'hyprctl -j workspaces' response: expected an array.");
  }

  const occupied = new Set<number>();
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    if (typeof entry.id !== "number" || !Number.isInteger(entry.id) || entry.id <= 0) continue;
    if (typeof entry.windows !== "number" || entry.windows <= 0) continue;
    occupied.add(entry.id);
  }

  return occupied;
}

export function listChildPids(pid: number): ReadonlyArray<number> {
  if (pid <= 0) {
    return [];
  }

  const pgrepResult = spawnSync("pgrep", ["-P", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (pgrepResult.error) {
    const errorCode = (pgrepResult.error as NodeJS.ErrnoException).code;
    if (errorCode !== "ENOENT") {
      throw new Error(`Unable to execute pgrep: ${String(pgrepResult.error)}.`);
    }
  } else if (pgrepResult.status === 0) {
    return pgrepResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => Number(line))
      .filter((value) => Number.isInteger(value) && value > 0);
  } else if (pgrepResult.status === 1) {
    return [];
  } else {
    throw new Error(
      `pgrep failed for pid ${String(pid)} with status ${String(pgrepResult.status)}.`,
    );
  }

  const psResult = spawnSync("ps", ["-o", "pid=", "--ppid", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (psResult.error) {
    throw new Error(`Unable to execute ps: ${String(psResult.error)}.`);
  }
  if (psResult.status !== 0) {
    throw new Error(`ps failed for pid ${String(pid)} with status ${String(psResult.status)}.`);
  }

  return psResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => Number(line))
    .filter((value) => Number.isInteger(value) && value > 0);
}

export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === "ESRCH") {
      return false;
    }
    if (errorCode === "EPERM") {
      return true;
    }
    throw error;
  }
}

function collectProcessTreePids(
  rootPid: number,
  listChildPidsImpl: (pid: number) => ReadonlyArray<number>,
): ReadonlyArray<number> {
  const visited = new Set<number>();
  const ordered: Array<number> = [];

  const visit = (pid: number) => {
    if (pid <= 0 || visited.has(pid)) {
      return;
    }
    visited.add(pid);
    for (const childPid of listChildPidsImpl(pid)) {
      visit(childPid);
    }
    ordered.push(pid);
  };

  visit(rootPid);
  return ordered;
}

export async function killProcessTree(input: {
  readonly pid: number;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly listChildPids: (pid: number) => ReadonlyArray<number>;
  readonly killProcess: (pid: number, signal: NodeJS.Signals | 0) => void;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<void> {
  if (input.pid <= 0 || !input.isProcessAlive(input.pid)) {
    return;
  }

  const processTreePids = collectProcessTreePids(input.pid, input.listChildPids);
  for (const pid of processTreePids) {
    if (!input.isProcessAlive(pid)) continue;
    try {
      input.killProcess(pid, "SIGTERM");
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode !== "ESRCH") {
        throw error;
      }
    }
  }

  await input.sleep(PROCESS_TERMINATION_WAIT_MS);

  for (const pid of processTreePids) {
    if (!input.isProcessAlive(pid)) continue;
    try {
      input.killProcess(pid, "SIGKILL");
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode !== "ESRCH") {
        throw error;
      }
    }
  }
}

export function dispatchWorkspace(workspace: number): void {
  runTextCommand("hyprctl", ["dispatch", "workspace", String(workspace)]);
}

export function dispatchExec(command: string): void {
  runTextCommand("hyprctl", ["dispatch", "exec", command]);
}

function assertSupportedEnvironment(env: NodeJS.ProcessEnv): void {
  if (process.platform !== "linux") {
    throw new Error("hypr-worktree only supports Linux.");
  }

  if (!env.HYPRLAND_INSTANCE_SIGNATURE?.trim()) {
    throw new Error("Hyprland does not appear to be running in this environment.");
  }
}

function loadRegistry(stateFilePath: string, fileSystem: FileSystemLike): WorkspaceRegistry {
  if (!fileSystem.existsSync(stateFilePath)) {
    return createEmptyRegistry();
  }

  return parseRegistry(fileSystem.readFileSync(stateFilePath, "utf8"));
}

function saveRegistry(
  stateFilePath: string,
  registry: WorkspaceRegistry,
  fileSystem: FileSystemLike,
): void {
  fileSystem.mkdirSync(Path.dirname(stateFilePath), { recursive: true });
  fileSystem.writeFileSync(stateFilePath, serializeRegistry(registry));
}

export function ensureWorkspaceAssignment(input: {
  readonly stateFilePath: string;
  readonly fileSystem: FileSystemLike;
  readonly resolveGitCommonDirForWorktree: (worktreeRoot: string) => string;
  readonly listOccupiedWorkspaces: () => ReadonlySet<number>;
  readonly worktree: ResolvedWorktree;
}): {
  readonly registry: WorkspaceRegistry;
  readonly assignment: WorkspaceAssignment;
  readonly stateChanged: boolean;
} {
  const loadedRegistry = loadRegistry(input.stateFilePath, input.fileSystem);
  const prunedRegistry = pruneAssignments(loadedRegistry, input.resolveGitCommonDirForWorktree);
  let stateChanged = serializeRegistry(prunedRegistry) !== serializeRegistry(loadedRegistry);

  const existingAssignment = prunedRegistry.assignments[input.worktree.key];
  if (existingAssignment) {
    if (stateChanged) {
      saveRegistry(input.stateFilePath, prunedRegistry, input.fileSystem);
    }

    return {
      registry: prunedRegistry,
      assignment: existingAssignment,
      stateChanged,
    };
  }

  const reservedWorkspaces = new Set<number>();
  for (const assignment of Object.values(prunedRegistry.assignments)) {
    reservedWorkspaces.add(assignment.workspace);
  }

  const workspace = selectWorkspace({
    workspaceStart: prunedRegistry.workspaceStart,
    occupiedWorkspaces: input.listOccupiedWorkspaces(),
    reservedWorkspaces,
  });

  const nextAssignment: WorkspaceAssignment = {
    repoCommonDir: input.worktree.repoCommonDir,
    worktreeRoot: input.worktree.worktreeRoot,
    workspace,
    pid: 0,
  };

  const nextRegistry: WorkspaceRegistry = {
    version: REGISTRY_VERSION,
    workspaceStart: prunedRegistry.workspaceStart,
    assignments: {
      ...prunedRegistry.assignments,
      [input.worktree.key]: nextAssignment,
    },
  };

  saveRegistry(input.stateFilePath, nextRegistry, input.fileSystem);
  stateChanged = true;

  return {
    registry: nextRegistry,
    assignment: nextAssignment,
    stateChanged,
  };
}

function formatAssignmentLine(pid: number, workspace: number, worktreeRoot: string): string {
  return `pid=${String(pid)} workspace=${String(workspace)} worktree=${worktreeRoot}`;
}

function createNodeDeps(): CliDeps {
  return {
    cwd: () => process.cwd(),
    env: process.env,
    fileSystem: defaultFileSystem(),
    homeDir: homedir(),
    resolveWorktreeFromCwd,
    resolveGitCommonDirForWorktree,
    listOccupiedWorkspaces,
    dispatchWorkspace,
    dispatchExec,
    isProcessAlive,
    listChildPids,
    killProcess: (pid, signal) => {
      process.kill(pid, signal);
    },
    sleep: async (ms) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    },
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

function tryReadPidFile(
  pidFilePath: string,
  fileSystem: FileSystemLike,
): { readonly pid: number | null; readonly exists: boolean } {
  if (!fileSystem.existsSync(pidFilePath)) {
    return { pid: null, exists: false };
  }

  const rawValue = fileSystem.readFileSync(pidFilePath, "utf8").trim();
  if (rawValue.length === 0) {
    return { pid: null, exists: true };
  }

  const pid = Number(rawValue);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Managed pid file '${pidFilePath}' does not contain a valid pid.`);
  }

  return { pid, exists: true };
}

async function waitForManagedPid(input: {
  readonly pidFilePath: string;
  readonly fileSystem: FileSystemLike;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<number> {
  for (let elapsedMs = 0; elapsedMs <= PID_POLL_TIMEOUT_MS; elapsedMs += PID_POLL_INTERVAL_MS) {
    const pidResult = tryReadPidFile(input.pidFilePath, input.fileSystem);
    if (pidResult.pid !== null) {
      return pidResult.pid;
    }

    if (elapsedMs === PID_POLL_TIMEOUT_MS) {
      break;
    }

    await input.sleep(PID_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for managed pid file '${input.pidFilePath}'.`);
}

function removePidFileIfPresent(pidFilePath: string, fileSystem: FileSystemLike): void {
  if (!fileSystem.existsSync(pidFilePath)) {
    return;
  }

  try {
    fileSystem.unlinkSync(pidFilePath);
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode !== "ENOENT") {
      throw error;
    }
  }
}

export async function runCli(argv: ReadonlyArray<string>, deps: CliDeps): Promise<CliResult> {
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];
  const writeStdout = (line: string) => {
    stdout.push(line);
    deps.stdout(line);
  };
  const writeStderr = (line: string) => {
    stderr.push(line);
    deps.stderr(line);
  };

  try {
    assertSupportedEnvironment(deps.env);

    const [command, ...rest] = argv;
    if (!command) {
      throw new Error("Missing subcommand. Expected one of: spawn, where, goto.");
    }

    if (command !== "spawn" && command !== "where" && command !== "goto") {
      throw new Error(`Unknown subcommand '${command}'. Expected one of: spawn, where, goto.`);
    }

    const worktree = deps.resolveWorktreeFromCwd(deps.cwd());
    const stateFilePath = resolveStateFilePath(deps.env, deps.homeDir);
    const assignmentState = ensureWorkspaceAssignment({
      stateFilePath,
      fileSystem: deps.fileSystem,
      resolveGitCommonDirForWorktree: deps.resolveGitCommonDirForWorktree,
      listOccupiedWorkspaces: deps.listOccupiedWorkspaces,
      worktree,
    });
    let assignment = assignmentState.assignment;
    let registry = assignmentState.registry;
    const pidFilePath = resolvePidFilePath(deps.env, worktree.key, deps.homeDir);

    if (command === "where") {
      writeStdout(String(assignment.workspace));
      return { exitCode: 0, stdout, stderr };
    }

    if (command === "goto") {
      deps.dispatchWorkspace(assignment.workspace);
      writeStdout(String(assignment.workspace));
      return { exitCode: 0, stdout, stderr };
    }

    const { silent, remainingArgs } = resolveSpawnOptions(rest);
    const shellCommand = resolveCommandString(remainingArgs);

    if (assignment.pid > 0 && deps.isProcessAlive(assignment.pid)) {
      await killProcessTree({
        pid: assignment.pid,
        isProcessAlive: deps.isProcessAlive,
        listChildPids: deps.listChildPids,
        killProcess: deps.killProcess,
        sleep: deps.sleep,
      });
    }

    removePidFileIfPresent(pidFilePath, deps.fileSystem);

    const clearedAssignment: WorkspaceAssignment = {
      ...assignment,
      pid: 0,
    };
    registry = {
      version: REGISTRY_VERSION,
      workspaceStart: registry.workspaceStart,
      assignments: {
        ...registry.assignments,
        [worktree.key]: clearedAssignment,
      },
    };
    saveRegistry(stateFilePath, registry, deps.fileSystem);
    assignment = clearedAssignment;

    if (!silent) {
      deps.dispatchWorkspace(assignment.workspace);
    }

    deps.dispatchExec(
      buildSpawnDispatch({
        workspace: assignment.workspace,
        cwd: worktree.cwd,
        command: shellCommand,
        silent,
        pidFilePath,
      }),
    );

    const pid = await waitForManagedPid({
      pidFilePath,
      fileSystem: deps.fileSystem,
      sleep: deps.sleep,
    });
    const nextAssignment: WorkspaceAssignment = {
      ...assignment,
      pid,
    };
    const nextRegistry: WorkspaceRegistry = {
      version: REGISTRY_VERSION,
      workspaceStart: registry.workspaceStart,
      assignments: {
        ...registry.assignments,
        [worktree.key]: nextAssignment,
      },
    };
    saveRegistry(stateFilePath, nextRegistry, deps.fileSystem);

    writeStdout(formatAssignmentLine(pid, assignment.workspace, worktree.worktreeRoot));
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`[hypr-worktree] ${message}`);
    return { exitCode: 1, stdout, stderr };
  }
}

if (import.meta.main) {
  const result = await runCli(process.argv.slice(2), createNodeDeps());
  process.exitCode = result.exitCode;
}
