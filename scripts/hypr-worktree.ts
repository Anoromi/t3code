#!/usr/bin/env node

import * as FS from "node:fs";
import { homedir } from "node:os";
import * as Path from "node:path";
import { execFileSync } from "node:child_process";

import {
  createAssignmentKey,
  normalizePath,
  resolveGitCommonDirForWorktree,
  resolveWorktreeFromCwd,
  type ResolvedWorktree,
} from "./lib/worktree.ts";

export const DEFAULT_WORKSPACE_START = 11;

export interface WorkspaceAssignment {
  readonly repoCommonDir: string;
  readonly worktreeRoot: string;
  readonly workspace: number;
}

export interface WorkspaceRegistry {
  readonly version: 1;
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
    version: 1,
    workspaceStart,
    assignments: {},
  };
}

export function resolveStateFilePath(env: NodeJS.ProcessEnv, homeDir: string = homedir()): string {
  const configuredStateHome = env.XDG_STATE_HOME?.trim();
  const stateHome =
    configuredStateHome && configuredStateHome.length > 0
      ? configuredStateHome
      : Path.join(homeDir, ".local", "state");

  return Path.join(stateHome, "hypr-workspaces", "assignments.json");
}

function ensurePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${label}: expected a positive integer.`);
  }

  return value;
}

function ensureNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${label}: expected a non-empty string.`);
  }

  return normalizePath(value);
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
  if (version !== 1) {
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
    if (!isRecord(rawValue)) {
      throw new Error(`Malformed assignment '${key}': expected an object.`);
    }

    const assignment: WorkspaceAssignment = {
      repoCommonDir: ensureNonEmptyString(
        rawValue.repoCommonDir,
        `assignment '${key}'.repoCommonDir`,
      ),
      worktreeRoot: ensureNonEmptyString(rawValue.worktreeRoot, `assignment '${key}'.worktreeRoot`),
      workspace: ensurePositiveInteger(rawValue.workspace, `assignment '${key}'.workspace`),
    };

    const expectedKey = createAssignmentKey(assignment.repoCommonDir, assignment.worktreeRoot);
    if (key !== expectedKey) {
      throw new Error(
        `Malformed assignment '${key}': key does not match repoCommonDir/worktreeRoot identity.`,
      );
    }

    if (seenIdentityKeys.has(expectedKey)) {
      throw new Error(`Duplicate assignment record for '${expectedKey}'.`);
    }

    seenIdentityKeys.add(expectedKey);
    assignments[expectedKey] = assignment;
  }

  return {
    version: 1,
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
    version: 1,
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

export function buildSpawnDispatch(input: {
  readonly workspace: number;
  readonly cwd: string;
  readonly command: string;
  readonly silent: boolean;
}): string {
  const workspaceRule = input.silent
    ? `[workspace ${String(input.workspace)} silent]`
    : `[workspace ${String(input.workspace)}]`;

  return `${workspaceRule} ${buildShellLaunchCommand(input.cwd, input.command)}`;
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
  readonly workspace: number;
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
      workspace: existingAssignment.workspace,
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

  const nextRegistry: WorkspaceRegistry = {
    version: 1,
    workspaceStart: prunedRegistry.workspaceStart,
    assignments: {
      ...prunedRegistry.assignments,
      [input.worktree.key]: {
        repoCommonDir: input.worktree.repoCommonDir,
        worktreeRoot: input.worktree.worktreeRoot,
        workspace,
      },
    },
  };

  saveRegistry(input.stateFilePath, nextRegistry, input.fileSystem);
  stateChanged = true;

  return {
    registry: nextRegistry,
    workspace,
    stateChanged,
  };
}

function formatAssignmentLine(workspace: number, worktreeRoot: string): string {
  return `workspace=${String(workspace)} worktree=${worktreeRoot}`;
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
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

export function runCli(argv: ReadonlyArray<string>, deps: CliDeps): CliResult {
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
    const assignment = ensureWorkspaceAssignment({
      stateFilePath,
      fileSystem: deps.fileSystem,
      resolveGitCommonDirForWorktree: deps.resolveGitCommonDirForWorktree,
      listOccupiedWorkspaces: deps.listOccupiedWorkspaces,
      worktree,
    });

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

    if (!silent) {
      deps.dispatchWorkspace(assignment.workspace);
    }

    deps.dispatchExec(
      buildSpawnDispatch({
        workspace: assignment.workspace,
        cwd: worktree.cwd,
        command: shellCommand,
        silent,
      }),
    );

    writeStdout(formatAssignmentLine(assignment.workspace, worktree.worktreeRoot));
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`[hypr-worktree] ${message}`);
    return { exitCode: 1, stdout, stderr };
  }
}

if (import.meta.main) {
  const result = runCli(process.argv.slice(2), createNodeDeps());
  process.exitCode = result.exitCode;
}
