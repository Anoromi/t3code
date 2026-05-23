// @effect-diagnostics nodeBuiltinImport:off
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DesktopE2eApp {
  readonly app: ElectronApplication;
  readonly page: Page;
  readonly expectNoFatalLogs: () => void;
  readonly logs: () => string;
  readonly cleanup: () => Promise<void>;
}

export interface DesktopE2eProcess {
  readonly app: ElectronApplication;
  readonly repoDir: string;
  readonly t3Home: string;
  readonly port: number;
  readonly logs: () => string;
  readonly expectNoFatalLogs: () => void;
  readonly cleanup: () => Promise<void>;
}

export interface DesktopE2eLaunchOptions {
  readonly fixtureFiles?: Readonly<Record<string, string>>;
  readonly extraEnv?: NodeJS.ProcessEnv;
}

export type DesktopE2eProcessLaunchOptions = DesktopE2eLaunchOptions & {
  readonly repoDir?: string;
  readonly t3Home?: string;
  readonly port?: number;
};

const desktopDir = path.resolve(import.meta.dirname, "..", "..");
const defaultRepoRoot = path.resolve(desktopDir, "..", "..");
const fatalLogPatterns = [
  "Cannot find module",
  "MODULE_NOT_FOUND",
  "Uncaught Error",
  "Uncaught TypeError",
  "Uncaught ReferenceError",
  "Provider session error",
];

function resolveRepoRoot(): string {
  return path.resolve(process.env.T3CODE_DESKTOP_E2E_APP_ROOT?.trim() || defaultRepoRoot);
}

function resolveDesktopDir(): string {
  return path.join(resolveRepoRoot(), "apps", "desktop");
}

function resolveMainPath(): string {
  return path.join(resolveDesktopDir(), "dist-electron", "main.cjs");
}

async function execGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return stdout;
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close(() => reject(new Error("Failed to allocate a TCP port.")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function createGitFixture(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "t3code-desktop-e2e-repo-"));
  await execGit(repoDir, ["init", "--initial-branch=main"]);
  await execGit(repoDir, ["config", "user.email", "e2e@example.test"]);
  await execGit(repoDir, ["config", "user.name", "T3 Code E2E"]);
  const fixtureFiles = { "README.md": "# Desktop E2E\n", ...files };
  for (const [relativePath, contents] of Object.entries(fixtureFiles)) {
    const filePath = path.join(repoDir, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
  }
  for (const relativePath of Object.keys(fixtureFiles)) {
    await execGit(repoDir, ["add", relativePath]);
  }
  await execGit(repoDir, ["commit", "-m", "initial commit"]);
  return repoDir;
}

export async function launchDesktopE2eProcess(
  options: DesktopE2eProcessLaunchOptions = {},
): Promise<DesktopE2eProcess> {
  const mainPath = resolveMainPath();
  await fs.access(mainPath).catch(() => {
    throw new Error(
      `Desktop Electron bundle not found at ${mainPath}. Run \`bun run build:desktop\` before \`bun run test:desktop-playwright\`.`,
    );
  });

  const repoDir = options.repoDir ?? (await createGitFixture(options.fixtureFiles));
  const ownsRepoDir = options.repoDir === undefined;
  const t3Home =
    options.t3Home ?? (await fs.mkdtemp(path.join(os.tmpdir(), "t3code-desktop-e2e-home-")));
  const ownsT3Home = options.t3Home === undefined;
  const port = options.port ?? (await findFreePort());
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let output = "";

  const app = await electron.launch({
    args: [mainPath],
    cwd: resolveDesktopDir(),
    env: {
      ...env,
      T3CODE_HOME: t3Home,
      T3CODE_PORT: String(port),
      T3CODE_E2E_FAKE_PROVIDER: "1",
      T3CODE_E2E_BACKEND_CWD: repoDir,
      T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "1",
      ...options.extraEnv,
      ELECTRON_ENABLE_LOGGING: "1",
    },
  });
  app.process().stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  app.process().stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });

  return {
    app,
    repoDir,
    t3Home,
    port,
    expectNoFatalLogs: () => {
      const fatalMatches = fatalLogPatterns.filter((pattern) => output.includes(pattern));
      if (fatalMatches.length > 0) {
        throw new Error(
          `Desktop E2E logs contain fatal patterns: ${fatalMatches.join(", ")}\n${output}`,
        );
      }
    },
    logs: () => output,
    cleanup: async () => {
      await app.close().catch(() => undefined);
      if (ownsRepoDir) {
        await fs.rm(repoDir, { recursive: true, force: true });
      }
      if (ownsT3Home) {
        await fs.rm(t3Home, { recursive: true, force: true });
      }
    },
  };
}

export async function launchDesktopE2eApp(
  options: DesktopE2eLaunchOptions = {},
): Promise<DesktopE2eApp> {
  const process = await launchDesktopE2eProcess(options);

  let page: Page;
  try {
    page = await process.app.firstWindow();
  } catch (error) {
    process.app.process().kill("SIGKILL");
    await process.cleanup();
    throw new Error(`Desktop Electron window did not open.\n\nCaptured logs:\n${process.logs()}`, {
      cause: error,
    });
  }

  return {
    app: process.app,
    page,
    expectNoFatalLogs: process.expectNoFatalLogs,
    logs: process.logs,
    cleanup: process.cleanup,
  };
}
