#!/usr/bin/env node

import { createHash } from "node:crypto";
import * as FS from "node:fs";
import { homedir } from "node:os";
import * as Path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import {
  createAssignmentKey,
  normalizePath,
  resolveGitCommonDirForWorktree,
  resolveWorktreeFromCwd,
  type ResolvedWorktree,
} from "./lib/worktree.ts";

const MANAGED_WORKSPACE = 1;
const GHOSTTY_CLASS_PREFIX = "dev.t3tools.t3code.ghostty";
const CLIENT_POLL_INTERVAL_MS = 100;
const CLIENT_POLL_TIMEOUT_MS = 3_000;

export interface GhosttyAssignment {
  readonly repoCommonDir: string;
  readonly worktreeRoot: string;
  readonly pid: number;
  readonly className: string;
  readonly title: string;
}

export interface GhosttyRegistry {
  readonly version: 1;
  readonly assignments: Record<string, GhosttyAssignment>;
}

export interface HyprClient {
  readonly address: string;
  readonly workspace: number;
  readonly pid: number;
  readonly className: string;
  readonly title: string;
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
  readonly listClients: () => ReadonlyArray<HyprClient>;
  readonly dispatchWorkspace: (workspace: number) => void;
  readonly dispatchFocusWindow: (address: string) => void;
  readonly dispatchMoveToWorkspace: (workspace: number, address: string) => void;
  readonly dispatchExec: (command: string) => void;
  readonly assertGhosttyAvailable: () => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export interface ParsedCliArgs {
  readonly execCommand: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultFileSystem(): FileSystemLike {
  return {
    existsSync: FS.existsSync,
    mkdirSync: FS.mkdirSync,
    readFileSync: FS.readFileSync,
    writeFileSync: FS.writeFileSync,
  };
}

function runTextCommand(command: string, args: ReadonlyArray<string>): string {
  try {
    return execFileSync(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}: ${String(error)}`, {
      cause: error,
    });
  }
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

  return value;
}

function ensureNormalizedPath(value: unknown, label: string): string {
  return normalizePath(ensureNonEmptyString(value, label));
}

export function createEmptyRegistry(): GhosttyRegistry {
  return {
    version: 1,
    assignments: {},
  };
}

export function resolveStateFilePath(env: NodeJS.ProcessEnv, homeDir: string = homedir()): string {
  const configuredStateHome = env.XDG_STATE_HOME?.trim();
  const stateHome =
    configuredStateHome && configuredStateHome.length > 0
      ? configuredStateHome
      : Path.join(homeDir, ".local", "state");

  return Path.join(stateHome, "ghostty-worktree", "assignments.json");
}

export function createManagedClassName(worktreeKey: string): string {
  const suffix = createHash("sha256").update(worktreeKey).digest("hex").slice(0, 12);
  return `${GHOSTTY_CLASS_PREFIX}.w${suffix}`;
}

export function createManagedTitle(worktree: ResolvedWorktree): string {
  const repoName = Path.basename(Path.dirname(worktree.repoCommonDir));
  const worktreeName = Path.basename(worktree.worktreeRoot);
  return repoName === worktreeName ? `Ghostty ${repoName}` : `Ghostty ${repoName}:${worktreeName}`;
}

export function parseRegistry(contents: string): GhosttyRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Malformed ghostty-worktree registry JSON: ${String(error)}.`, {
      cause: error,
    });
  }

  if (!isRecord(parsed)) {
    throw new Error("Malformed ghostty-worktree registry JSON: expected an object.");
  }

  if (parsed.version !== 1) {
    throw new Error(`Unsupported ghostty-worktree registry version: ${String(parsed.version)}.`);
  }

  const rawAssignments = parsed.assignments;
  if (!isRecord(rawAssignments)) {
    throw new Error("Malformed ghostty-worktree registry JSON: assignments must be an object.");
  }

  const assignments: Record<string, GhosttyAssignment> = {};
  for (const [key, rawValue] of Object.entries(rawAssignments)) {
    if (!isRecord(rawValue)) {
      throw new Error(`Malformed assignment '${key}': expected an object.`);
    }

    const assignment: GhosttyAssignment = {
      repoCommonDir: ensureNormalizedPath(
        rawValue.repoCommonDir,
        `assignment '${key}'.repoCommonDir`,
      ),
      worktreeRoot: ensureNormalizedPath(rawValue.worktreeRoot, `assignment '${key}'.worktreeRoot`),
      pid: ensurePositiveInteger(rawValue.pid, `assignment '${key}'.pid`),
      className: ensureNonEmptyString(rawValue.className, `assignment '${key}'.className`),
      title: ensureNonEmptyString(rawValue.title, `assignment '${key}'.title`),
    };

    const expectedKey = createAssignmentKey(assignment.repoCommonDir, assignment.worktreeRoot);
    if (key !== expectedKey) {
      throw new Error(
        `Malformed assignment '${key}': key does not match repoCommonDir/worktreeRoot identity.`,
      );
    }

    assignments[key] = assignment;
  }

  return {
    version: 1,
    assignments,
  };
}

export function serializeRegistry(registry: GhosttyRegistry): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

export function pruneAssignments(
  registry: GhosttyRegistry,
  resolveGitCommonDirForWorktreeImpl: (worktreeRoot: string) => string,
): GhosttyRegistry {
  const nextAssignments: Record<string, GhosttyAssignment> = {};

  for (const assignment of Object.values(registry.assignments)) {
    try {
      const resolvedCommonDir = normalizePath(
        resolveGitCommonDirForWorktreeImpl(assignment.worktreeRoot),
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
    assignments: nextAssignments,
  };
}

export function findManagedClient(
  clients: ReadonlyArray<HyprClient>,
  assignment: GhosttyAssignment,
): HyprClient | null {
  for (const client of clients) {
    if (client.pid !== assignment.pid) continue;
    if (client.className !== assignment.className) continue;
    return client;
  }

  return null;
}

export function findManagedClientByClassName(
  clients: ReadonlyArray<HyprClient>,
  className: string,
): HyprClient | null {
  for (const client of clients) {
    if (client.className !== className) continue;
    return client;
  }

  return null;
}

function loadRegistry(stateFilePath: string, fileSystem: FileSystemLike): GhosttyRegistry {
  if (!fileSystem.existsSync(stateFilePath)) {
    return createEmptyRegistry();
  }

  return parseRegistry(fileSystem.readFileSync(stateFilePath, "utf8"));
}

function saveRegistry(
  stateFilePath: string,
  registry: GhosttyRegistry,
  fileSystem: FileSystemLike,
): void {
  fileSystem.mkdirSync(Path.dirname(stateFilePath), { recursive: true });
  fileSystem.writeFileSync(stateFilePath, serializeRegistry(registry));
}

function formatAssignmentLine(pid: number, workspace: number, worktreeRoot: string): string {
  return `pid=${String(pid)} workspace=${String(workspace)} worktree=${worktreeRoot}`;
}

export function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildGhosttyLaunchCommand(input: {
  readonly className: string;
  readonly cwd: string;
  readonly title: string;
  readonly workspace: number;
  readonly execCommand?: string | null;
}): string {
  const execCommand = input.execCommand?.trim();
  const launcherScript =
    execCommand && execCommand.length > 0
      ? 'exec ghostty --gtk-single-instance=false --class="$1" --title="$2" --working-directory="$3" -e sh -lc "$4"'
      : 'exec ghostty --gtk-single-instance=false --class="$1" --title="$2" --working-directory="$3"';
  return [
    `[workspace ${String(input.workspace)} silent]`,
    "sh",
    "-lc",
    quoteShellArg(launcherScript),
    "ghostty-worktree",
    quoteShellArg(input.className),
    quoteShellArg(input.title),
    quoteShellArg(input.cwd),
    ...(execCommand && execCommand.length > 0 ? [quoteShellArg(execCommand)] : []),
  ].join(" ");
}

export function parseCliArgs(argv: ReadonlyArray<string>): ParsedCliArgs {
  if (argv.length === 0) {
    return { execCommand: null };
  }

  if (argv.length === 2 && argv[0] === "--exec") {
    const execCommand = argv[1]?.trim();
    if (!execCommand) {
      throw new Error("ghostty-worktree requires a non-empty command after --exec.");
    }
    return { execCommand };
  }

  throw new Error("ghostty-worktree only accepts an optional --exec <command> argument.");
}

function assertSupportedEnvironment(env: NodeJS.ProcessEnv): void {
  if (process.platform !== "linux") {
    throw new Error("ghostty-worktree only supports Linux.");
  }

  if (!env.HYPRLAND_INSTANCE_SIGNATURE?.trim()) {
    throw new Error("Hyprland does not appear to be running in this environment.");
  }
}

async function waitForManagedClientByClassName(input: {
  readonly className: string;
  readonly deps: Pick<CliDeps, "listClients" | "sleep">;
}): Promise<HyprClient> {
  for (
    let elapsedMs = 0;
    elapsedMs <= CLIENT_POLL_TIMEOUT_MS;
    elapsedMs += CLIENT_POLL_INTERVAL_MS
  ) {
    const client = findManagedClientByClassName(input.deps.listClients(), input.className);
    if (client !== null) {
      return client;
    }

    if (elapsedMs === CLIENT_POLL_TIMEOUT_MS) {
      break;
    }

    await input.deps.sleep(CLIENT_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for managed Ghostty window for class ${input.className}.`);
}

function createNodeDeps(): CliDeps {
  return {
    cwd: () => process.cwd(),
    env: process.env,
    fileSystem: defaultFileSystem(),
    homeDir: homedir(),
    resolveWorktreeFromCwd,
    resolveGitCommonDirForWorktree,
    listClients: () => {
      const raw = runTextCommand("hyprctl", ["-j", "clients"]);
      let parsed: unknown;

      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new Error(`Failed to parse 'hyprctl -j clients': ${String(error)}.`, {
          cause: error,
        });
      }

      if (!Array.isArray(parsed)) {
        throw new Error("Unexpected 'hyprctl -j clients' response: expected an array.");
      }

      const clients: Array<HyprClient> = [];
      for (const entry of parsed) {
        if (!isRecord(entry)) continue;
        if (typeof entry.address !== "string" || entry.address.length === 0) continue;
        if (typeof entry.pid !== "number" || !Number.isInteger(entry.pid) || entry.pid <= 0)
          continue;
        if (!isRecord(entry.workspace)) continue;
        if (
          typeof entry.workspace.id !== "number" ||
          !Number.isInteger(entry.workspace.id) ||
          entry.workspace.id <= 0
        ) {
          continue;
        }

        clients.push({
          address: entry.address,
          workspace: entry.workspace.id,
          pid: entry.pid,
          className: typeof entry.class === "string" ? entry.class : "",
          title: typeof entry.title === "string" ? entry.title : "",
        });
      }

      return clients;
    },
    dispatchWorkspace: (workspace) => {
      runTextCommand("hyprctl", ["dispatch", "workspace", String(workspace)]);
    },
    dispatchFocusWindow: (address) => {
      runTextCommand("hyprctl", ["dispatch", "focuswindow", `address:${address}`]);
    },
    dispatchMoveToWorkspace: (workspace, address) => {
      runTextCommand("hyprctl", [
        "dispatch",
        "movetoworkspacesilent",
        `${String(workspace)},address:${address}`,
      ]);
    },
    dispatchExec: (command) => {
      runTextCommand("hyprctl", ["dispatch", "exec", command]);
    },
    assertGhosttyAvailable: () => {
      const result = spawnSync("ghostty", ["+version"], {
        encoding: "utf8",
        stdio: "ignore",
      });

      if (result.error) {
        if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error("Ghostty does not appear to be installed in PATH.");
        }

        throw new Error(`Unable to execute Ghostty: ${String(result.error)}.`);
      }

      if (result.status !== 0) {
        throw new Error("Ghostty is installed but unavailable in this environment.");
      }
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
    const parsedArgs = parseCliArgs(argv);

    assertSupportedEnvironment(deps.env);
    deps.assertGhosttyAvailable();

    const worktree = deps.resolveWorktreeFromCwd(deps.cwd());
    const stateFilePath = resolveStateFilePath(deps.env, deps.homeDir);
    const loadedRegistry = loadRegistry(stateFilePath, deps.fileSystem);
    const prunedRegistry = pruneAssignments(loadedRegistry, deps.resolveGitCommonDirForWorktree);
    const className = createManagedClassName(worktree.key);
    const title = createManagedTitle(worktree);

    let nextRegistry = prunedRegistry;
    let stateChanged = serializeRegistry(prunedRegistry) !== serializeRegistry(loadedRegistry);

    const existingAssignment = prunedRegistry.assignments[worktree.key];
    if (existingAssignment) {
      const liveClient = findManagedClient(deps.listClients(), existingAssignment);
      if (liveClient !== null) {
        if (stateChanged) {
          saveRegistry(stateFilePath, prunedRegistry, deps.fileSystem);
        }

        deps.dispatchWorkspace(liveClient.workspace);
        deps.dispatchFocusWindow(liveClient.address);
        writeStdout(
          formatAssignmentLine(existingAssignment.pid, liveClient.workspace, worktree.worktreeRoot),
        );
        return { exitCode: 0, stdout, stderr };
      }

      const recoveredClient = findManagedClientByClassName(deps.listClients(), className);
      if (recoveredClient !== null) {
        const recoveredAssignment: GhosttyAssignment = {
          repoCommonDir: worktree.repoCommonDir,
          worktreeRoot: worktree.worktreeRoot,
          pid: recoveredClient.pid,
          className,
          title,
        };
        nextRegistry = {
          version: 1,
          assignments: {
            ...prunedRegistry.assignments,
            [worktree.key]: recoveredAssignment,
          },
        };
        saveRegistry(stateFilePath, nextRegistry, deps.fileSystem);
        deps.dispatchWorkspace(recoveredClient.workspace);
        deps.dispatchFocusWindow(recoveredClient.address);
        writeStdout(
          formatAssignmentLine(
            recoveredClient.pid,
            recoveredClient.workspace,
            worktree.worktreeRoot,
          ),
        );
        return { exitCode: 0, stdout, stderr };
      }

      const { [worktree.key]: _removed, ...remainingAssignments } = prunedRegistry.assignments;
      nextRegistry = {
        version: 1,
        assignments: remainingAssignments,
      };
      stateChanged = true;
    }

    const assignment: GhosttyAssignment = {
      repoCommonDir: worktree.repoCommonDir,
      worktreeRoot: worktree.worktreeRoot,
      pid: 0,
      className,
      title,
    };

    deps.dispatchExec(
      buildGhosttyLaunchCommand({
        className,
        cwd: worktree.cwd,
        title,
        workspace: MANAGED_WORKSPACE,
        execCommand: parsedArgs.execCommand,
      }),
    );

    try {
      const client = await waitForManagedClientByClassName({
        className,
        deps,
      });
      const createdAssignment: GhosttyAssignment = {
        ...assignment,
        pid: client.pid,
      };

      nextRegistry = {
        version: 1,
        assignments: {
          ...nextRegistry.assignments,
          [worktree.key]: createdAssignment,
        },
      };
      saveRegistry(stateFilePath, nextRegistry, deps.fileSystem);

      if (client.workspace !== MANAGED_WORKSPACE) {
        deps.dispatchMoveToWorkspace(MANAGED_WORKSPACE, client.address);
      }

      deps.dispatchWorkspace(MANAGED_WORKSPACE);
      deps.dispatchFocusWindow(client.address);
      writeStdout(formatAssignmentLine(client.pid, MANAGED_WORKSPACE, worktree.worktreeRoot));
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      if (stateChanged || nextRegistry !== prunedRegistry) {
        saveRegistry(stateFilePath, nextRegistry, deps.fileSystem);
      }

      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(`[ghostty-worktree] ${message}`);
    return { exitCode: 1, stdout, stderr };
  }
}

if (import.meta.main) {
  const result = await runCli(process.argv.slice(2), createNodeDeps());
  process.exitCode = result.exitCode;
}
