#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { accessSync, constants, statSync } from "node:fs";

import {
  mergeAppRuntimeEnv,
  readLaunchEnvSnapshotFromFile,
  T3CODE_LOCAL_LAUNCH_ENV_FILE,
} from "../packages/shared/src/launchEnvironment.ts";

export const LAUNCHER_VERSION = 1;

const LOCAL_LAUNCH_DIRNAME = "local-launch";
const DEFAULT_T3_HOME = path.join(os.homedir(), ".t3");
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".playwright",
  ".t3",
  ".tanstack",
  ".turbo",
  "__screenshots__",
  "build",
  "dist",
  "dist-electron",
  "node_modules",
  "playwright-report",
  "release",
  "release-mock",
  "squashfs-root",
]);

export type LayerName = "install" | "web" | "server" | "desktop";

export interface LayerDefinition {
  readonly name: LayerName;
  readonly command: readonly string[];
  readonly inputRoots: ReadonlyArray<string>;
  readonly inputFiles: ReadonlyArray<string>;
  readonly requiredOutputs: ReadonlyArray<string>;
}

export interface LayerStamp {
  readonly repoRoot: string;
  readonly command: readonly string[];
  readonly completedAtMs: number;
  readonly inputRoots: ReadonlyArray<string>;
  readonly inputFiles: ReadonlyArray<string>;
  readonly requiredOutputs: ReadonlyArray<string>;
  readonly launcherVersion: number;
}

export interface LayerFreshness {
  readonly fresh: boolean;
  readonly reason: string;
  readonly stampPath: string;
}

export interface LocalDesktopLaunchOptions {
  readonly repoRoot: string;
  readonly forwardedArgs?: ReadonlyArray<string>;
  readonly t3Home?: string;
  readonly commandRunner?: CommandRunner;
  readonly log?: LogSink;
}

export interface CliArgs {
  readonly repoRoot: string;
  readonly forwardedArgs: ReadonlyArray<string>;
}

export interface CommandRunnerOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

export type CommandRunner = (
  command: readonly string[],
  options: CommandRunnerOptions,
) => Promise<void>;

export type LogSink = (line: string) => void;

type NewerInputMatch = {
  readonly type: "newer";
  readonly relativePath: string;
};

type MissingInputMatch = {
  readonly type: "missing";
  readonly relativePath: string;
};

type InputMatch = NewerInputMatch | MissingInputMatch;

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function formatRepoRelativePath(repoRoot: string, absolutePath: string): string {
  return normalizeRelativePath(path.relative(repoRoot, absolutePath));
}

function shouldIgnoreDirectory(directoryName: string): boolean {
  return IGNORED_DIRECTORY_NAMES.has(directoryName) || directoryName.startsWith(".vitest-");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listWorkspacePackageJsonFiles(
  repoRoot: string,
  workspaceDirName: "apps" | "packages",
): Promise<ReadonlyArray<string>> {
  const workspaceRoot = path.join(repoRoot, workspaceDirName);
  let entries: Dirent<string>[];

  try {
    entries = await readdir(workspaceRoot, { encoding: "utf8", withFileTypes: true });
  } catch {
    return [];
  }

  const packageJsonFiles = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(workspaceDirName, entry.name, "package.json"))
    .toSorted((left, right) => left.localeCompare(right));

  const existing = await Promise.all(
    packageJsonFiles.map(async (relativePath) =>
      (await pathExists(path.join(repoRoot, relativePath))) ? relativePath : null,
    ),
  );

  return existing.filter((relativePath): relativePath is string => relativePath !== null);
}

export async function resolveLayerDefinitions(
  repoRoot: string,
): Promise<ReadonlyArray<LayerDefinition>> {
  const normalizedRepoRoot = path.resolve(repoRoot);
  const workspacePackageJsonFiles = [
    ...(await listWorkspacePackageJsonFiles(normalizedRepoRoot, "apps")),
    ...(await listWorkspacePackageJsonFiles(normalizedRepoRoot, "packages")),
    "scripts/package.json",
  ];

  return [
    {
      name: "install",
      command: ["bun", "install", "--frozen-lockfile", "--linker=hoisted", "--ignore-scripts"],
      inputRoots: [],
      inputFiles: ["bun.lock", "package.json", ...workspacePackageJsonFiles],
      requiredOutputs: ["node_modules", ".bun"],
    },
    {
      name: "web",
      command: ["bun", "run", "--cwd", "apps/web", "build"],
      inputRoots: ["apps/web", "packages/client-runtime", "packages/contracts", "packages/shared"],
      inputFiles: ["package.json", "bun.lock", "turbo.json"],
      requiredOutputs: ["apps/web/dist/index.html"],
    },
    {
      name: "server",
      command: ["bun", "run", "--cwd", "apps/server", "build"],
      inputRoots: ["apps/server", "packages/contracts", "packages/shared", "apps/web/dist"],
      inputFiles: ["package.json", "bun.lock", "turbo.json"],
      requiredOutputs: ["apps/server/dist/bin.mjs", "apps/server/dist/client/index.html"],
    },
    {
      name: "desktop",
      command: ["bun", "run", "--cwd", "apps/desktop", "build"],
      inputRoots: ["apps/desktop", "packages/contracts", "packages/shared"],
      inputFiles: ["package.json", "bun.lock", "turbo.json"],
      requiredOutputs: [
        "apps/desktop/dist-electron/main.cjs",
        "apps/desktop/dist-electron/preload.cjs",
      ],
    },
  ];
}

export function resolveT3Home(explicitT3Home?: string): string {
  const configured = explicitT3Home?.trim() || process.env.T3CODE_HOME?.trim();
  return configured ? path.resolve(configured) : DEFAULT_T3_HOME;
}

export function hashRepoRoot(repoRoot: string): string {
  return createHash("sha256").update(path.resolve(repoRoot)).digest("hex").slice(0, 12);
}

export function resolveStateDir(repoRoot: string, t3Home = resolveT3Home()): string {
  return path.join(path.resolve(t3Home), LOCAL_LAUNCH_DIRNAME, hashRepoRoot(repoRoot));
}

async function findFirstInputChange(
  repoRoot: string,
  absoluteRoot: string,
  stampMtimeMs: number,
): Promise<InputMatch | null> {
  let entries: Dirent<string>[];

  try {
    entries = await readdir(absoluteRoot, { encoding: "utf8", withFileTypes: true });
  } catch {
    return {
      type: "missing",
      relativePath: formatRepoRelativePath(repoRoot, absoluteRoot),
    };
  }

  const sortedEntries = entries.toSorted((left, right) => left.name.localeCompare(right.name));
  for (const entry of sortedEntries) {
    const absolutePath = path.join(absoluteRoot, entry.name);

    if (entry.isDirectory()) {
      if (shouldIgnoreDirectory(entry.name)) {
        continue;
      }

      const nestedMatch = await findFirstInputChange(repoRoot, absolutePath, stampMtimeMs);
      if (nestedMatch !== null) {
        return nestedMatch;
      }

      continue;
    }

    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }

    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      stats = await stat(absolutePath);
    } catch {
      return {
        type: "missing",
        relativePath: formatRepoRelativePath(repoRoot, absolutePath),
      };
    }

    if (stats.isDirectory()) {
      if (shouldIgnoreDirectory(entry.name)) {
        continue;
      }

      const nestedMatch = await findFirstInputChange(repoRoot, absolutePath, stampMtimeMs);
      if (nestedMatch !== null) {
        return nestedMatch;
      }
      continue;
    }

    if (!stats.isFile()) {
      continue;
    }

    if (stats.mtimeMs > stampMtimeMs) {
      return {
        type: "newer",
        relativePath: formatRepoRelativePath(repoRoot, absolutePath),
      };
    }
  }

  return null;
}

async function readStampMtimeMs(stampPath: string): Promise<number | null> {
  try {
    const stampStats = await stat(stampPath);
    return stampStats.mtimeMs;
  } catch {
    return null;
  }
}

function formatInputChangeReason(change: InputMatch): string {
  if (change.type === "missing") {
    return `${change.relativePath} missing`;
  }

  return `${change.relativePath} newer than stamp`;
}

export async function evaluateLayerFreshness(
  repoRoot: string,
  stateDir: string,
  layer: LayerDefinition,
): Promise<LayerFreshness> {
  const normalizedRepoRoot = path.resolve(repoRoot);
  const stampPath = path.join(stateDir, `${layer.name}.json`);
  const stampMtimeMs = await readStampMtimeMs(stampPath);

  if (stampMtimeMs === null) {
    return {
      fresh: false,
      reason: "stamp missing",
      stampPath,
    };
  }

  for (const relativeOutputPath of layer.requiredOutputs) {
    const absoluteOutputPath = path.join(normalizedRepoRoot, relativeOutputPath);
    if (!(await pathExists(absoluteOutputPath))) {
      return {
        fresh: false,
        reason: `${normalizeRelativePath(relativeOutputPath)} missing`,
        stampPath,
      };
    }
  }

  for (const relativeInputPath of layer.inputFiles) {
    const absoluteInputPath = path.join(normalizedRepoRoot, relativeInputPath);
    let inputStats: Awaited<ReturnType<typeof stat>>;

    try {
      inputStats = await stat(absoluteInputPath);
    } catch {
      return {
        fresh: false,
        reason: `${normalizeRelativePath(relativeInputPath)} missing`,
        stampPath,
      };
    }

    if (inputStats.mtimeMs > stampMtimeMs) {
      return {
        fresh: false,
        reason: `${normalizeRelativePath(relativeInputPath)} newer than stamp`,
        stampPath,
      };
    }
  }

  for (const relativeInputRoot of layer.inputRoots) {
    const absoluteInputRoot = path.join(normalizedRepoRoot, relativeInputRoot);
    const change = await findFirstInputChange(normalizedRepoRoot, absoluteInputRoot, stampMtimeMs);
    if (change !== null) {
      return {
        fresh: false,
        reason: formatInputChangeReason(change),
        stampPath,
      };
    }
  }

  return {
    fresh: true,
    reason: "fresh",
    stampPath,
  };
}

export async function writeLayerStamp(
  repoRoot: string,
  stateDir: string,
  layer: LayerDefinition,
  completedAtMs = Date.now(),
): Promise<string> {
  await mkdir(stateDir, { recursive: true });
  const stampPath = path.join(stateDir, `${layer.name}.json`);
  const stamp: LayerStamp = {
    repoRoot: path.resolve(repoRoot),
    command: layer.command,
    completedAtMs,
    inputRoots: layer.inputRoots,
    inputFiles: layer.inputFiles,
    requiredOutputs: layer.requiredOutputs,
    launcherVersion: LAUNCHER_VERSION,
  };
  await writeFile(stampPath, `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
  return stampPath;
}

function formatCommand(command: readonly string[]): string {
  return command.join(" ");
}

function getExitCode(error: unknown): number {
  if (typeof error === "object" && error !== null) {
    const maybeExitCode = Reflect.get(error, "exitCode");
    if (typeof maybeExitCode === "number" && Number.isInteger(maybeExitCode)) {
      return maybeExitCode;
    }
  }
  return 1;
}

export function resolveExecutableFromPath(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  if (path.isAbsolute(command)) {
    return command;
  }

  const pathValue = env.PATH ?? "";
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const pathEntries = pathValue.split(pathDelimiter).filter((entry) => entry.trim().length > 0);
  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((entry) => entry.trim().length > 0)
      : [""];

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, `${command}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        if (!statSync(candidate).isFile()) {
          continue;
        }
        return candidate;
      } catch {
        continue;
      }
    }
  }

  throw new Error(`Unable to resolve executable '${command}' from PATH.`);
}

export const defaultCommandRunner: CommandRunner = async (command, options) => {
  const [file, ...args] = command;
  if (!file) {
    throw new Error("Command must not be empty");
  }
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.signal) {
    process.kill(process.pid, result.signal);
  }

  if ((result.status ?? 0) !== 0) {
    const error = new Error(
      `${formatCommand(command)} exited with status ${result.status ?? 1}`,
    ) as Error & {
      exitCode?: number;
    };
    error.exitCode = result.status ?? 1;
    throw error;
  }
};

function logWithPrefix(log: LogSink, message: string): void {
  log(`[local-launch] ${message}`);
}

export async function runLocalDesktopLaunch(options: LocalDesktopLaunchOptions): Promise<number> {
  const repoRoot = path.resolve(options.repoRoot);
  const forwardedArgs = options.forwardedArgs ?? [];
  const log = options.log ?? console.log;
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const stateDir = resolveStateDir(repoRoot, options.t3Home);
  const layers = await resolveLayerDefinitions(repoRoot);

  for (const layer of layers) {
    const freshness = await evaluateLayerFreshness(repoRoot, stateDir, layer);
    if (freshness.fresh) {
      logWithPrefix(log, `${layer.name} fresh`);
      continue;
    }

    logWithPrefix(log, `${layer.name} stale: ${freshness.reason}`);
    logWithPrefix(log, `rebuilding ${layer.name}`);

    try {
      await commandRunner(layer.command, { cwd: repoRoot });
    } catch (error) {
      logWithPrefix(log, `${layer.name} command failed: ${formatCommand(layer.command)}`);
      return getExitCode(error);
    }

    await writeLayerStamp(repoRoot, stateDir, layer);
  }

  const launchEnv =
    (await readLaunchEnvSnapshotFromFile(process.env[T3CODE_LOCAL_LAUNCH_ENV_FILE])) ?? process.env;
  if (process.env[T3CODE_LOCAL_LAUNCH_ENV_FILE]?.trim() && launchEnv === process.env) {
    logWithPrefix(log, "launch env snapshot unavailable; falling back to current process env");
  }
  const desktopRuntimeEnv = mergeAppRuntimeEnv({
    launchEnv,
    currentEnv: process.env,
    preserveKeys: [
      T3CODE_LOCAL_LAUNCH_ENV_FILE,
      "T3CODE_HOME",
      "T3CODE_STATE_DIR",
      "T3CODE_DESKTOP_OZONE_PLATFORM",
      "T3CODE_DESKTOP_MOCK_UPDATES",
      "T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT",
      "T3CODE_DESKTOP_PACKAGE_CHANNEL",
      "T3CODE_DISABLE_AUTO_UPDATE",
      "T3CODE_DESKTOP_LAN_HOST",
      "T3CODE_PORT",
      "T3CODE_OTLP_TRACES_URL",
      "T3CODE_OTLP_METRICS_URL",
      "T3CODE_OTLP_SERVICE_NAME",
      "T3CODE_BUN_EXECUTABLE",
    ],
  });
  const bunExecutable =
    process.env.T3CODE_BUN_EXECUTABLE?.trim() || resolveExecutableFromPath("bun", process.env);
  desktopRuntimeEnv.T3CODE_BUN_EXECUTABLE = bunExecutable;
  const desktopStartCommand = [
    bunExecutable,
    "run",
    "--cwd",
    "apps/desktop",
    "start",
    "--",
    ...forwardedArgs,
  ];
  logWithPrefix(log, "launching desktop");

  try {
    await commandRunner(desktopStartCommand, { cwd: repoRoot, env: desktopRuntimeEnv });
    return 0;
  } catch (error) {
    logWithPrefix(log, `desktop start command failed: ${formatCommand(desktopStartCommand)}`);
    return getExitCode(error);
  }
}

export function parseCliArgs(argv: ReadonlyArray<string>): CliArgs {
  const args = [...argv];
  const separatorIndex = args.indexOf("--");
  const beforeSeparator = separatorIndex >= 0 ? args.slice(0, separatorIndex) : args;
  const forwardedArgs = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];
  let repoRoot: string | null = null;

  for (let index = 0; index < beforeSeparator.length; index += 1) {
    const current = beforeSeparator[index];
    if (current === "--repo-root") {
      const nextValue = beforeSeparator[index + 1];
      if (!nextValue) {
        throw new Error("Missing value for --repo-root");
      }
      repoRoot = nextValue;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${current}`);
  }

  if (!repoRoot) {
    throw new Error("Missing required --repo-root argument");
  }

  return {
    repoRoot,
    forwardedArgs,
  };
}

async function main(): Promise<void> {
  let cliArgs: CliArgs;

  try {
    cliArgs = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[local-launch] ${message}`);
    process.exit(1);
    return;
  }

  const exitCode = await runLocalDesktopLaunch({
    repoRoot: cliArgs.repoRoot,
    forwardedArgs: cliArgs.forwardedArgs,
  });
  process.exit(exitCode);
}

if (import.meta.main) {
  void main();
}
