import { mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  evaluateLayerFreshness,
  hashRepoRoot,
  resolveLayerDefinitions,
  resolveStateDir,
  runLocalDesktopLaunch,
  type CommandRunner,
  type LayerDefinition,
  writeLayerStamp,
} from "./local-desktop-launch.ts";

const createdTempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  createdTempDirs.push(directory);
  return directory;
}

async function ensureFile(
  rootDir: string,
  relativePath: string,
  contents = relativePath,
): Promise<void> {
  const absolutePath = path.join(rootDir, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents, "utf8");
}

async function ensureDirectory(rootDir: string, relativePath: string): Promise<void> {
  await mkdir(path.join(rootDir, relativePath), { recursive: true });
}

async function touchPath(rootDir: string, relativePath: string, timeMs: number): Promise<void> {
  const absolutePath = path.join(rootDir, relativePath);
  const time = new Date(timeMs);
  await utimes(absolutePath, time, time);
}

async function createFixtureRepo(): Promise<string> {
  const repoRoot = await createTempDir("local-desktop-launch-repo-");
  const fixtureFiles = [
    "package.json",
    "bun.lock",
    "turbo.json",
    "scripts/package.json",
    "apps/web/package.json",
    "apps/web/src/index.tsx",
    "apps/server/package.json",
    "apps/server/src/bin.ts",
    "apps/desktop/package.json",
    "apps/desktop/src/main.ts",
    "packages/client-runtime/package.json",
    "packages/client-runtime/src/index.ts",
    "packages/contracts/package.json",
    "packages/contracts/src/index.ts",
    "packages/shared/package.json",
    "packages/shared/src/index.ts",
  ] as const;

  for (const relativePath of fixtureFiles) {
    await ensureFile(repoRoot, relativePath);
  }

  return repoRoot;
}

async function createLayerOutputs(repoRoot: string, layer: LayerDefinition): Promise<void> {
  for (const relativeOutputPath of layer.requiredOutputs) {
    const absoluteOutputPath = path.join(repoRoot, relativeOutputPath);
    if (path.extname(relativeOutputPath)) {
      await ensureFile(repoRoot, relativeOutputPath, `${layer.name}:${relativeOutputPath}`);
      continue;
    }
    await mkdir(absoluteOutputPath, { recursive: true });
  }
}

async function getLayer(repoRoot: string, name: LayerDefinition["name"]): Promise<LayerDefinition> {
  const layers = await resolveLayerDefinitions(repoRoot);
  const layer = layers.find((candidate) => candidate.name === name);
  if (!layer) {
    throw new Error(`Missing layer ${name}`);
  }
  return layer;
}

async function seedFreshLayer(
  repoRoot: string,
  t3Home: string,
  name: LayerDefinition["name"],
): Promise<void> {
  const layer = await getLayer(repoRoot, name);
  await createLayerOutputs(repoRoot, layer);
  await writeLayerStamp(repoRoot, resolveStateDir(repoRoot, t3Home), layer);
}

async function seedFreshAllLayers(repoRoot: string, t3Home: string): Promise<void> {
  const layers = await resolveLayerDefinitions(repoRoot);
  for (const layer of layers) {
    await createLayerOutputs(repoRoot, layer);
    await writeLayerStamp(repoRoot, resolveStateDir(repoRoot, t3Home), layer);
  }
}

function createCommandRunner(
  repoRoot: string,
  failCommandPrefix?: string,
): { readonly commands: string[]; readonly runner: CommandRunner } {
  const commands: string[] = [];

  const runner: CommandRunner = async (command) => {
    const rendered = command.join(" ");
    commands.push(rendered);

    if (failCommandPrefix && rendered.startsWith(failCommandPrefix)) {
      const error = new Error(`Simulated failure for ${rendered}`) as Error & { exitCode?: number };
      error.exitCode = 23;
      throw error;
    }

    if (rendered === "bun install --frozen-lockfile --linker=hoisted --ignore-scripts") {
      await ensureDirectory(repoRoot, "node_modules");
      await ensureDirectory(repoRoot, ".bun");
      return;
    }

    if (rendered === "bun run --cwd apps/web build") {
      await ensureFile(repoRoot, "apps/web/dist/index.html", "web build");
      return;
    }

    if (rendered === "bun run --cwd apps/server build") {
      await ensureFile(repoRoot, "apps/server/dist/bin.mjs", "server build");
      await ensureFile(repoRoot, "apps/server/dist/client/index.html", "server client build");
      return;
    }

    if (rendered === "bun run --cwd apps/desktop build") {
      await ensureFile(repoRoot, "apps/desktop/dist-electron/main.cjs", "desktop main");
      await ensureFile(repoRoot, "apps/desktop/dist-electron/preload.cjs", "desktop preload");
      return;
    }

    if (rendered.startsWith("bun run --cwd apps/desktop start --")) {
      return;
    }

    throw new Error(`Unexpected command: ${rendered}`);
  };

  return { commands, runner };
}

afterEach(async () => {
  await Promise.all(
    createdTempDirs.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("local-desktop-launch freshness", () => {
  it("marks a layer stale when its stamp is missing", async () => {
    const repoRoot = await createFixtureRepo();
    const t3Home = await createTempDir("local-desktop-launch-home-");
    const webLayer = await getLayer(repoRoot, "web");

    await createLayerOutputs(repoRoot, webLayer);

    const freshness = await evaluateLayerFreshness(
      repoRoot,
      resolveStateDir(repoRoot, t3Home),
      webLayer,
    );

    expect(freshness).toMatchObject({
      fresh: false,
      reason: "stamp missing",
    });
  });

  it("marks a layer stale when a required output is missing", async () => {
    const repoRoot = await createFixtureRepo();
    const t3Home = await createTempDir("local-desktop-launch-home-");
    const webLayer = await getLayer(repoRoot, "web");

    await writeLayerStamp(repoRoot, resolveStateDir(repoRoot, t3Home), webLayer);

    const freshness = await evaluateLayerFreshness(
      repoRoot,
      resolveStateDir(repoRoot, t3Home),
      webLayer,
    );

    expect(freshness).toMatchObject({
      fresh: false,
      reason: "apps/web/dist/index.html missing",
    });
  });

  it("marks a layer stale when an input file is newer than the stamp", async () => {
    const repoRoot = await createFixtureRepo();
    const t3Home = await createTempDir("local-desktop-launch-home-");
    const webLayer = await getLayer(repoRoot, "web");

    await createLayerOutputs(repoRoot, webLayer);
    const stampPath = await writeLayerStamp(repoRoot, resolveStateDir(repoRoot, t3Home), webLayer);
    const stampStats = await stat(stampPath);

    await touchPath(repoRoot, "apps/web/src/index.tsx", stampStats.mtimeMs + 5_000);

    const freshness = await evaluateLayerFreshness(
      repoRoot,
      resolveStateDir(repoRoot, t3Home),
      webLayer,
    );

    expect(freshness).toMatchObject({
      fresh: false,
      reason: "apps/web/src/index.tsx newer than stamp",
    });
  });

  it("treats older inputs and present outputs as fresh", async () => {
    const repoRoot = await createFixtureRepo();
    const t3Home = await createTempDir("local-desktop-launch-home-");
    const webLayer = await getLayer(repoRoot, "web");

    await createLayerOutputs(repoRoot, webLayer);
    await writeLayerStamp(repoRoot, resolveStateDir(repoRoot, t3Home), webLayer);

    const freshness = await evaluateLayerFreshness(
      repoRoot,
      resolveStateDir(repoRoot, t3Home),
      webLayer,
    );

    expect(freshness).toMatchObject({
      fresh: true,
      reason: "fresh",
    });
  });

  it("ignores generated directories when checking freshness", async () => {
    const repoRoot = await createFixtureRepo();
    const t3Home = await createTempDir("local-desktop-launch-home-");
    const webLayer = await getLayer(repoRoot, "web");

    await createLayerOutputs(repoRoot, webLayer);
    const stampPath = await writeLayerStamp(repoRoot, resolveStateDir(repoRoot, t3Home), webLayer);
    const stampStats = await stat(stampPath);

    await ensureFile(repoRoot, "apps/web/node_modules/generated.js", "generated");
    await touchPath(repoRoot, "apps/web/node_modules/generated.js", stampStats.mtimeMs + 5_000);

    const freshness = await evaluateLayerFreshness(
      repoRoot,
      resolveStateDir(repoRoot, t3Home),
      webLayer,
    );

    expect(freshness).toMatchObject({
      fresh: true,
      reason: "fresh",
    });
  });

  it("marks the server layer stale when web dist is newer than the server stamp", async () => {
    const repoRoot = await createFixtureRepo();
    const t3Home = await createTempDir("local-desktop-launch-home-");
    const serverLayer = await getLayer(repoRoot, "server");

    await createLayerOutputs(repoRoot, await getLayer(repoRoot, "web"));
    await createLayerOutputs(repoRoot, serverLayer);
    const stampPath = await writeLayerStamp(
      repoRoot,
      resolveStateDir(repoRoot, t3Home),
      serverLayer,
    );
    const stampStats = await stat(stampPath);

    await touchPath(repoRoot, "apps/web/dist/index.html", stampStats.mtimeMs + 5_000);

    const freshness = await evaluateLayerFreshness(
      repoRoot,
      resolveStateDir(repoRoot, t3Home),
      serverLayer,
    );

    expect(freshness).toMatchObject({
      fresh: false,
      reason: "apps/web/dist/index.html newer than stamp",
    });
  });

  it("separates state directories by repo root hash", async () => {
    const t3Home = await createTempDir("local-desktop-launch-home-");
    const firstRepoRoot = await createFixtureRepo();
    const secondRepoRoot = await createFixtureRepo();

    expect(resolveStateDir(firstRepoRoot, t3Home)).not.toEqual(
      resolveStateDir(secondRepoRoot, t3Home),
    );
    expect(hashRepoRoot(firstRepoRoot)).not.toEqual(hashRepoRoot(secondRepoRoot));
  });
});

describe("runLocalDesktopLaunch", () => {
  it("builds every layer on a cold launch", async () => {
    const repoRoot = await createFixtureRepo();
    const t3Home = await createTempDir("local-desktop-launch-home-");
    const { commands, runner } = createCommandRunner(repoRoot);

    const exitCode = await runLocalDesktopLaunch({
      repoRoot,
      t3Home,
      commandRunner: runner,
      forwardedArgs: ["--inspect"],
      log: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(commands).toEqual([
      "bun install --frozen-lockfile --linker=hoisted --ignore-scripts",
      "bun run --cwd apps/web build",
      "bun run --cwd apps/server build",
      "bun run --cwd apps/desktop build",
      "bun run --cwd apps/desktop start -- --inspect",
    ]);

    const stateDir = resolveStateDir(repoRoot, t3Home);
    for (const layerName of ["install", "web", "server", "desktop"] as const) {
      const stamp = JSON.parse(
        await readFile(path.join(stateDir, `${layerName}.json`), "utf8"),
      ) as {
        launcherVersion: number;
      };
      expect(stamp.launcherVersion).toBe(1);
    }
  });

  it("reuses cached outputs on the next launch", async () => {
    const repoRoot = await createFixtureRepo();
    const t3Home = await createTempDir("local-desktop-launch-home-");

    await seedFreshAllLayers(repoRoot, t3Home);

    const { commands, runner } = createCommandRunner(repoRoot);
    const exitCode = await runLocalDesktopLaunch({
      repoRoot,
      t3Home,
      commandRunner: runner,
      log: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(commands).toEqual(["bun run --cwd apps/desktop start --"]);
  });

  it("rebuilds web and server when a web source file changes", async () => {
    const repoRoot = await createFixtureRepo();
    const t3Home = await createTempDir("local-desktop-launch-home-");

    await seedFreshAllLayers(repoRoot, t3Home);
    const webStampPath = path.join(resolveStateDir(repoRoot, t3Home), "web.json");
    const webStampStats = await stat(webStampPath);
    await touchPath(repoRoot, "apps/web/src/index.tsx", webStampStats.mtimeMs + 5_000);

    const { commands, runner } = createCommandRunner(repoRoot);
    const exitCode = await runLocalDesktopLaunch({
      repoRoot,
      t3Home,
      commandRunner: runner,
      log: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(commands).toEqual([
      "bun run --cwd apps/web build",
      "bun run --cwd apps/server build",
      "bun run --cwd apps/desktop start --",
    ]);
  });

  it("rebuilds only desktop when a desktop source file changes", async () => {
    const repoRoot = await createFixtureRepo();
    const t3Home = await createTempDir("local-desktop-launch-home-");

    await seedFreshAllLayers(repoRoot, t3Home);
    const desktopStampPath = path.join(resolveStateDir(repoRoot, t3Home), "desktop.json");
    const desktopStampStats = await stat(desktopStampPath);
    await touchPath(repoRoot, "apps/desktop/src/main.ts", desktopStampStats.mtimeMs + 5_000);

    const { commands, runner } = createCommandRunner(repoRoot);
    const exitCode = await runLocalDesktopLaunch({
      repoRoot,
      t3Home,
      commandRunner: runner,
      log: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(commands).toEqual([
      "bun run --cwd apps/desktop build",
      "bun run --cwd apps/desktop start --",
    ]);
  });

  it("reruns install and downstream builds when the lockfile changes", async () => {
    const repoRoot = await createFixtureRepo();
    const t3Home = await createTempDir("local-desktop-launch-home-");

    await seedFreshAllLayers(repoRoot, t3Home);
    const installStampPath = path.join(resolveStateDir(repoRoot, t3Home), "install.json");
    const installStampStats = await stat(installStampPath);
    await touchPath(repoRoot, "bun.lock", installStampStats.mtimeMs + 5_000);

    const { commands, runner } = createCommandRunner(repoRoot);
    const exitCode = await runLocalDesktopLaunch({
      repoRoot,
      t3Home,
      commandRunner: runner,
      log: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(commands).toEqual([
      "bun install --frozen-lockfile --linker=hoisted --ignore-scripts",
      "bun run --cwd apps/web build",
      "bun run --cwd apps/server build",
      "bun run --cwd apps/desktop build",
      "bun run --cwd apps/desktop start --",
    ]);
  });

  it("fails closed and leaves the web stamp untouched when the web build fails", async () => {
    const repoRoot = await createFixtureRepo();
    const t3Home = await createTempDir("local-desktop-launch-home-");

    await seedFreshLayer(repoRoot, t3Home, "install");

    const { commands, runner } = createCommandRunner(repoRoot, "bun run --cwd apps/web build");
    const exitCode = await runLocalDesktopLaunch({
      repoRoot,
      t3Home,
      commandRunner: runner,
      log: () => undefined,
    });

    expect(exitCode).toBe(23);
    expect(commands).toEqual(["bun run --cwd apps/web build"]);
    await expect(stat(path.join(resolveStateDir(repoRoot, t3Home), "web.json"))).rejects.toThrow();
  });

  it("rebuilds a layer when a required output is deleted", async () => {
    const repoRoot = await createFixtureRepo();
    const t3Home = await createTempDir("local-desktop-launch-home-");

    await seedFreshAllLayers(repoRoot, t3Home);
    await unlink(path.join(repoRoot, "apps/desktop/dist-electron/preload.cjs"));

    const { commands, runner } = createCommandRunner(repoRoot);
    const exitCode = await runLocalDesktopLaunch({
      repoRoot,
      t3Home,
      commandRunner: runner,
      log: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(commands).toEqual([
      "bun run --cwd apps/desktop build",
      "bun run --cwd apps/desktop start --",
    ]);
  });
});
