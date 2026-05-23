#!/usr/bin/env bun
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off

import { execFileSync } from "node:child_process";
import { access, mkdir, rename, rm, stat } from "node:fs/promises";
import * as NodeOS from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import * as Hash from "effect/Hash";

interface GitWorktreeEntry {
  readonly path: string;
  readonly branch: string | null;
}

const STATE_DB_FILE = "state.sqlite";
const SQLITE_SIDE_CARS = [`${STATE_DB_FILE}-wal`, `${STATE_DB_FILE}-shm`] as const;
const ACTIVE_RUNTIME_WARNING_MS = 5 * 60 * 1000;

export interface CopyLiveDbArgs {
  readonly source?: string;
  readonly targetStateDir?: string;
  readonly homeDir?: string;
  readonly dryRun: boolean;
}

export interface CopyLiveDbPlan {
  readonly sourcePath: string;
  readonly targetStateDir: string;
  readonly targetDbPath: string;
  readonly targetSidecarPaths: readonly string[];
  readonly explicitTargetStateDir: boolean;
}

export class CopyLiveDbError extends Error {
  override readonly name = "CopyLiveDbError";
}

function pathExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

function expandHome(path: string, homeDir = NodeOS.homedir()): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/")) return join(homeDir, path.slice(2));
  return path;
}

function resolvePath(path: string, homeDir = NodeOS.homedir()): string {
  return resolve(expandHome(path, homeDir));
}

function defaultT3Home(env: NodeJS.ProcessEnv): string {
  return env.T3CODE_HOME?.trim() || join(NodeOS.homedir(), ".t3");
}

function loadGitWorktreeListPorcelain(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf8",
    });
  } catch {
    return undefined;
  }
}

function hashToHex8(value: string): string {
  return (Hash.string(value) >>> 0).toString(16).padStart(8, "0");
}

export function parseGitWorktreeListPorcelain(text: string): ReadonlyArray<GitWorktreeEntry> {
  const entries: GitWorktreeEntry[] = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;

  const flush = () => {
    if (!currentPath) {
      return;
    }
    entries.push({
      path: currentPath,
      branch: currentBranch,
    });
    currentPath = null;
    currentBranch = null;
  };

  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      currentPath = line.slice("worktree ".length).trim();
      continue;
    }
    if (line.startsWith("branch ")) {
      currentBranch = line.slice("branch ".length).trim() || null;
    }
  }
  flush();

  return entries;
}

export function resolveWorktreeStatePaths(input: {
  readonly baseDir: string;
  readonly currentWorktreeRoot: string;
  readonly gitWorktreeListPorcelain: string | undefined;
}): {
  readonly isMainWorktree: boolean;
  readonly stateDir: string;
  readonly mainStateDir: string;
} {
  const fallbackMainStateDir = resolve(input.baseDir, "dev");
  const parsedEntries = input.gitWorktreeListPorcelain
    ? parseGitWorktreeListPorcelain(input.gitWorktreeListPorcelain)
    : [];
  const mainEntry =
    parsedEntries.find((entry) => entry.branch === "refs/heads/main") ?? parsedEntries[0] ?? null;
  const repoName = mainEntry ? basename(resolve(mainEntry.path)) || "repo" : "repo";
  const currentWorktreeRoot = resolve(input.currentWorktreeRoot);
  const isMainWorktree = mainEntry ? resolve(mainEntry.path) === currentWorktreeRoot : true;

  if (isMainWorktree) {
    return {
      isMainWorktree: true,
      stateDir: fallbackMainStateDir,
      mainStateDir: fallbackMainStateDir,
    };
  }

  const worktreeBaseName = basename(currentWorktreeRoot) || "worktree";
  return {
    isMainWorktree: false,
    stateDir: resolve(
      input.baseDir,
      "dev-worktrees",
      repoName,
      `${worktreeBaseName}-${hashToHex8(currentWorktreeRoot)}`,
    ),
    mainStateDir: fallbackMainStateDir,
  };
}

export function parseCopyLiveDbArgs(argv: readonly string[]): CopyLiveDbArgs {
  const args: {
    source?: string;
    targetStateDir?: string;
    homeDir?: string;
    dryRun: boolean;
  } = { dryRun: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }

    if (arg === "--source" || arg === "--target-state-dir" || arg === "--home-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CopyLiveDbError(`Missing value for ${arg}.`);
      }
      index += 1;
      if (arg === "--source") args.source = value;
      if (arg === "--target-state-dir") args.targetStateDir = value;
      if (arg === "--home-dir") args.homeDir = value;
      continue;
    }

    throw new CopyLiveDbError(`Unknown argument: ${arg}`);
  }

  return args;
}

export function resolveCopyLiveDbPlan(input: {
  readonly args: CopyLiveDbArgs;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly gitWorktreeListPorcelain?: string;
}): CopyLiveDbPlan {
  const homeDir = resolvePath(input.args.homeDir ?? defaultT3Home(input.env));
  const sourcePath = resolvePath(input.args.source ?? join(homeDir, "userdata", STATE_DB_FILE));
  const explicitTargetStateDir = input.args.targetStateDir !== undefined;
  const targetStateDir = explicitTargetStateDir
    ? resolvePath(input.args.targetStateDir!)
    : resolveWorktreeStatePaths({
        baseDir: homeDir,
        currentWorktreeRoot: input.cwd,
        gitWorktreeListPorcelain:
          input.gitWorktreeListPorcelain ?? loadGitWorktreeListPorcelain(input.cwd),
      }).stateDir;
  const targetDbPath = join(targetStateDir, STATE_DB_FILE);

  return {
    sourcePath,
    targetStateDir,
    targetDbPath,
    targetSidecarPaths: SQLITE_SIDE_CARS.map((fileName) => join(targetStateDir, fileName)),
    explicitTargetStateDir,
  };
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function withSqlite<T>(
  dbPath: string,
  useDatabase: (database: {
    readonly close: () => void;
    readonly integrityCheck: () => string | undefined;
    readonly vacuumInto: (outputPath: string) => void;
  }) => T,
): Promise<T> {
  try {
    const bunSqliteSpecifier: string = "bun:sqlite";
    const { Database } = (await import(bunSqliteSpecifier)) as {
      readonly Database: new (
        path: string,
        options?: { readonly?: boolean },
      ) => {
        readonly close: () => void;
        readonly query: (sql: string) => { readonly get: () => unknown };
        readonly run: (sql: string) => void;
      };
    };
    const db = new Database(dbPath, { readonly: true });
    try {
      return useDatabase({
        close: () => db.close(),
        integrityCheck: () =>
          (db.query("PRAGMA integrity_check").get() as { integrity_check?: string } | null)
            ?.integrity_check,
        vacuumInto: (outputPath) => db.run(`VACUUM INTO ${quoteSqlString(outputPath)}`),
      });
    } finally {
      db.close();
    }
  } catch (bunImportOrRuntimeError) {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      return useDatabase({
        close: () => db.close(),
        integrityCheck: () =>
          (
            db.prepare("PRAGMA integrity_check").get() as
              | { readonly integrity_check?: string }
              | undefined
          )?.integrity_check,
        vacuumInto: (outputPath) => db.exec(`VACUUM INTO ${quoteSqlString(outputPath)}`),
      });
    } catch (nodeSqliteError) {
      if (bunImportOrRuntimeError instanceof Error && bunImportOrRuntimeError.message) {
        throw nodeSqliteError;
      }
      throw nodeSqliteError;
    } finally {
      db.close();
    }
  }
}

async function assertIntegrity(dbPath: string, label: string): Promise<void> {
  const result = await withSqlite(dbPath, (db) => db.integrityCheck());
  if (result !== "ok") {
    throw new CopyLiveDbError(`${label} database failed integrity_check.`);
  }
}

async function vacuumInto(sourcePath: string, outputPath: string): Promise<void> {
  await withSqlite(sourcePath, (db) => db.vacuumInto(outputPath));
}

async function warnIfTargetLooksActive(plan: CopyLiveDbPlan): Promise<void> {
  if (await pathExists(join(plan.targetStateDir, `${STATE_DB_FILE}-wal`))) {
    console.warn(
      `[copy-live-db] target WAL exists. Stop the dev server if copied data does not appear immediately.`,
    );
  }

  const serverRuntimePath = join(plan.targetStateDir, "server-runtime.json");
  try {
    const runtimeStat = await stat(serverRuntimePath);
    if (Date.now() - runtimeStat.mtimeMs <= ACTIVE_RUNTIME_WARNING_MS) {
      console.warn(
        `[copy-live-db] target server-runtime.json was recently touched. Stop the dev server if copied data does not appear immediately.`,
      );
    }
  } catch {
    // Missing runtime state is normal for fresh dev state dirs.
  }
}

export async function copyLiveDb(
  plan: CopyLiveDbPlan,
  options?: { dryRun?: boolean },
): Promise<void> {
  const dryRun = options?.dryRun ?? false;
  const sourcePath = resolve(plan.sourcePath);
  const targetDbPath = resolve(plan.targetDbPath);

  if (sourcePath === targetDbPath) {
    throw new CopyLiveDbError("Source and target database paths are the same.");
  }
  if (!(await pathExists(sourcePath))) {
    throw new CopyLiveDbError(`Source database does not exist: ${sourcePath}`);
  }

  const productionUserdataDir = resolve(dirname(sourcePath));
  if (!plan.explicitTargetStateDir && resolve(plan.targetStateDir) === productionUserdataDir) {
    throw new CopyLiveDbError(
      `Refusing to copy into production userdata state dir: ${plan.targetStateDir}`,
    );
  }

  await assertIntegrity(sourcePath, "Source");

  if (dryRun) {
    console.log("Would copy live database");
    console.log(`source: ${sourcePath}`);
    console.log(`target state dir: ${plan.targetStateDir}`);
    console.log(`target: ${targetDbPath}`);
    for (const sidecarPath of plan.targetSidecarPaths) {
      console.log(`would remove: ${sidecarPath}`);
    }
    return;
  }

  await warnIfTargetLooksActive(plan);

  await mkdir(plan.targetStateDir, { recursive: true });
  const tempDbPath = join(
    plan.targetStateDir,
    `${STATE_DB_FILE}.copy-live-${process.pid}-${Date.now()}.tmp`,
  );
  await rm(tempDbPath, { force: true });
  await vacuumInto(sourcePath, tempDbPath);
  await rm(targetDbPath, { force: true });
  for (const sidecarPath of plan.targetSidecarPaths) {
    await rm(sidecarPath, { force: true });
  }
  await rename(tempDbPath, targetDbPath);
  await assertIntegrity(targetDbPath, "Target");

  console.log("Copied live database");
  console.log(`source: ${sourcePath}`);
  console.log(`target: ${targetDbPath}`);
}

export async function runCopyLiveDbCli(
  argv = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<void> {
  const args = parseCopyLiveDbArgs(argv);
  const plan = resolveCopyLiveDbPlan({ args, env, cwd });
  await copyLiveDb(plan, { dryRun: args.dryRun });
}

if (import.meta.main) {
  runCopyLiveDbCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[copy-live-db] ${message}`);
    process.exitCode = 1;
  });
}
