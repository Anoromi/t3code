// @effect-diagnostics nodeBuiltinImport:off
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as NodeOS from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  CopyLiveDbError,
  copyLiveDb,
  parseCopyLiveDbArgs,
  resolveCopyLiveDbPlan,
} from "./copy-live-db.ts";

const MAIN_WORKTREE_CWD = "/repo/main";
const MAIN_WORKTREE_PORCELAIN = `worktree ${MAIN_WORKTREE_CWD}
branch refs/heads/main

`;

const SECONDARY_WORKTREE_CWD = "/repo/t3code-branch";
const SECONDARY_WORKTREE_PORCELAIN = `worktree ${MAIN_WORKTREE_CWD}
branch refs/heads/main

worktree ${SECONDARY_WORKTREE_CWD}
branch refs/heads/branch

`;

const createdTempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(NodeOS.tmpdir(), "t3-copy-live-db-test-"));
  createdTempDirs.push(dir);
  return dir;
}

function createSqliteDb(path: string, value: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE records (value TEXT NOT NULL)");
    db.prepare("INSERT INTO records (value) VALUES (?)").run(value);
  } finally {
    db.close();
  }
}

function readSqliteValue(path: string): string {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare("SELECT value FROM records LIMIT 1").get() as { value: string };
    return row.value;
  } finally {
    db.close();
  }
}

afterEach(async () => {
  await Promise.all(
    createdTempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("parseCopyLiveDbArgs", () => {
  it("parses supported flags", () => {
    expect(
      parseCopyLiveDbArgs([
        "--source",
        "/tmp/source.sqlite",
        "--target-state-dir",
        "/tmp/state",
        "--home-dir",
        "/tmp/t3",
        "--dry-run",
      ]),
    ).toEqual({
      source: "/tmp/source.sqlite",
      targetStateDir: "/tmp/state",
      homeDir: "/tmp/t3",
      dryRun: true,
    });
  });
});

describe("resolveCopyLiveDbPlan", () => {
  it("resolves the default source from T3CODE_HOME", () => {
    const plan = resolveCopyLiveDbPlan({
      args: { dryRun: false },
      env: { T3CODE_HOME: "/tmp/t3" },
      cwd: MAIN_WORKTREE_CWD,
      gitWorktreeListPorcelain: MAIN_WORKTREE_PORCELAIN,
    });

    expect(plan.sourcePath).toBe("/tmp/t3/userdata/state.sqlite");
  });

  it("resolves the main worktree target", () => {
    const plan = resolveCopyLiveDbPlan({
      args: { dryRun: false },
      env: { T3CODE_HOME: "/tmp/t3" },
      cwd: MAIN_WORKTREE_CWD,
      gitWorktreeListPorcelain: MAIN_WORKTREE_PORCELAIN,
    });

    expect(plan.targetDbPath).toBe("/tmp/t3/dev/state.sqlite");
  });

  it("resolves a secondary worktree target", () => {
    const plan = resolveCopyLiveDbPlan({
      args: { dryRun: false },
      env: { T3CODE_HOME: "/tmp/t3" },
      cwd: SECONDARY_WORKTREE_CWD,
      gitWorktreeListPorcelain: SECONDARY_WORKTREE_PORCELAIN,
    });

    expect(plan.targetDbPath).toMatch(
      /^\/tmp\/t3\/dev-worktrees\/main\/t3code-branch-[a-f0-9]{8}\/state\.sqlite$/,
    );
  });

  it("uses source and target overrides", () => {
    const plan = resolveCopyLiveDbPlan({
      args: {
        source: "/tmp/source.sqlite",
        targetStateDir: "/tmp/target-state",
        dryRun: false,
      },
      env: { T3CODE_HOME: "/tmp/t3" },
      cwd: MAIN_WORKTREE_CWD,
      gitWorktreeListPorcelain: MAIN_WORKTREE_PORCELAIN,
    });

    expect(plan.sourcePath).toBe("/tmp/source.sqlite");
    expect(plan.targetDbPath).toBe("/tmp/target-state/state.sqlite");
  });
});

describe("copyLiveDb", () => {
  it("dry-runs without removing or writing target files", async () => {
    const tempDir = await createTempDir();
    const sourcePath = join(tempDir, "source.sqlite");
    const targetStateDir = join(tempDir, "target");
    const targetDbPath = join(targetStateDir, "state.sqlite");
    createSqliteDb(sourcePath, "source");
    await mkdir(targetStateDir, { recursive: true });
    await writeFile(targetDbPath, "existing");

    await copyLiveDb(
      {
        sourcePath,
        targetStateDir,
        targetDbPath,
        targetSidecarPaths: [join(targetStateDir, "state.sqlite-wal")],
        explicitTargetStateDir: true,
      },
      { dryRun: true },
    );

    await expect(readFile(targetDbPath, "utf8")).resolves.toBe("existing");
  });

  it("refuses a missing source database", async () => {
    const tempDir = await createTempDir();

    await expect(
      copyLiveDb({
        sourcePath: join(tempDir, "missing.sqlite"),
        targetStateDir: join(tempDir, "target"),
        targetDbPath: join(tempDir, "target", "state.sqlite"),
        targetSidecarPaths: [],
        explicitTargetStateDir: true,
      }),
    ).rejects.toThrow(CopyLiveDbError);
  });

  it("refuses matching source and target paths", async () => {
    const tempDir = await createTempDir();
    const dbPath = join(tempDir, "state.sqlite");
    createSqliteDb(dbPath, "source");

    await expect(
      copyLiveDb({
        sourcePath: dbPath,
        targetStateDir: tempDir,
        targetDbPath: dbPath,
        targetSidecarPaths: [],
        explicitTargetStateDir: true,
      }),
    ).rejects.toThrow("Source and target database paths are the same.");
  });

  it("force replaces the target database and removes sidecars", async () => {
    const tempDir = await createTempDir();
    const sourcePath = join(tempDir, "source.sqlite");
    const targetStateDir = join(tempDir, "target");
    const targetDbPath = join(targetStateDir, "state.sqlite");
    const walPath = join(targetStateDir, "state.sqlite-wal");
    const shmPath = join(targetStateDir, "state.sqlite-shm");
    createSqliteDb(sourcePath, "source");
    await mkdir(targetStateDir, { recursive: true });
    createSqliteDb(targetDbPath, "target");
    await writeFile(walPath, "wal");
    await writeFile(shmPath, "shm");

    await copyLiveDb({
      sourcePath,
      targetStateDir,
      targetDbPath,
      targetSidecarPaths: [walPath, shmPath],
      explicitTargetStateDir: true,
    });

    expect(readSqliteValue(targetDbPath)).toBe("source");
    await expect(readFile(walPath)).rejects.toThrow();
    await expect(readFile(shmPath)).rejects.toThrow();
  });
});
