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
  readonly repoDir: string;
  readonly t3Home: string;
  readonly execGit: (args: readonly string[]) => Promise<string>;
  readonly readWorktreePath: (branch: string) => Promise<string | null>;
  readonly readLoggedProcessInvocations: () => Promise<ReadonlyArray<LoggedProcessInvocation>>;
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
  readonly fakeExecutables?: ReadonlyArray<"ghostty" | "hyprctl" | "hyprnav">;
}

export type DesktopE2eProcessLaunchOptions = DesktopE2eLaunchOptions & {
  readonly repoDir?: string;
  readonly t3Home?: string;
  readonly port?: number;
};

export interface LoggedProcessInvocation {
  readonly name: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

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

async function removeFixtureWorktrees(repoDir: string): Promise<void> {
  const output = await execGit(repoDir, ["worktree", "list", "--porcelain"]).catch(() => "");
  const worktreePaths: string[] = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (currentPath && currentPath !== repoDir) {
        worktreePaths.push(currentPath);
      }
      currentPath = line.slice("worktree ".length);
      currentBranch = null;
      continue;
    }
    if (line.startsWith("branch ")) {
      currentBranch = line.slice("branch ".length);
      if (currentPath && currentPath !== repoDir && currentBranch === "refs/heads/testing") {
        worktreePaths.push(currentPath);
      }
    }
  }
  if (currentPath && currentPath !== repoDir) {
    worktreePaths.push(currentPath);
  }

  for (const worktreePath of new Set(worktreePaths)) {
    await execGit(repoDir, ["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
  }
}

export async function readTestingWorktreePath(repoDir: string): Promise<string | null> {
  return readWorktreePath(repoDir, "testing");
}

async function readWorktreePath(repoDir: string, branch: string): Promise<string | null> {
  const output = await execGit(repoDir, ["worktree", "list", "--porcelain"]);
  let currentPath: string | null = null;
  const branchRef = `branch refs/heads/${branch}`;

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
      continue;
    }
    if (line === branchRef && currentPath) {
      return currentPath;
    }
  }

  return null;
}

async function installFakeExecutables(
  names: ReadonlyArray<"ghostty" | "hyprctl" | "hyprnav">,
): Promise<{ readonly binDir: string; readonly logPath: string }> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "t3code-desktop-e2e-bin-"));
  const logPath = path.join(binDir, "process-log.ndjson");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const stateDir = process.env.T3CODE_E2E_PROCESS_LOG ? path.dirname(process.env.T3CODE_E2E_PROCESS_LOG) : process.cwd();
const clientsPath = path.join(stateDir, "hypr-clients.json");
if (process.env.T3CODE_E2E_PROCESS_LOG) {
  fs.appendFileSync(process.env.T3CODE_E2E_PROCESS_LOG, JSON.stringify({ name, args, cwd: process.cwd() }) + "\\n");
}
function readClients() {
  try {
    return JSON.parse(fs.readFileSync(clientsPath, "utf8"));
  } catch {
    return [];
  }
}
function writeClients(clients) {
  fs.writeFileSync(clientsPath, JSON.stringify(clients));
}
function rememberClientFromArgs() {
  const joined = args.join(" ");
  const className = joined.match(/dev\\.t3tools\\.t3code\\.(?:ghostty|corkdiff)\\.[A-Za-z0-9_.-]+/)?.[0];
  if (!className) return;
  const clients = readClients();
  if (clients.some((client) => client.class === className)) return;
  clients.push({
    address: "0xe2e" + String(clients.length + 1),
    pid: 9000 + clients.length,
    class: className,
    workspace: { id: 101 },
    title: "T3 Code E2E",
  });
  writeClients(clients);
}
if (name === "hyprnav") {
  rememberClientFromArgs();
  process.stdout.write("101\\n");
  process.exit(0);
}
if (name === "hyprctl" && args[0] === "-j" && args[1] === "clients") {
  process.stdout.write(JSON.stringify(readClients()) + "\\n");
  process.exit(0);
}
if (name === "hyprctl" && args[0] === "-j" && args[1] === "workspaces") {
  process.stdout.write("[]\\n");
  process.exit(0);
}
process.exit(0);
`;

  for (const name of names) {
    const filePath = path.join(binDir, name);
    await fs.writeFile(filePath, script, { mode: 0o755 });
  }

  return { binDir, logPath };
}

async function readLoggedProcessInvocations(
  logPath: string | null,
): Promise<ReadonlyArray<LoggedProcessInvocation>> {
  if (!logPath) {
    return [];
  }
  const contents = await fs.readFile(logPath, "utf8").catch(() => "");
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedProcessInvocation);
}

export async function launchDesktopE2eProcess(
  options: DesktopE2eProcessLaunchOptions = {},
): Promise<
  DesktopE2eProcess & {
    readonly readLoggedProcessInvocations: () => Promise<ReadonlyArray<LoggedProcessInvocation>>;
  }
> {
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
  const fakeExecutables =
    options.fakeExecutables && options.fakeExecutables.length > 0
      ? await installFakeExecutables(options.fakeExecutables)
      : null;
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
      ...(fakeExecutables
        ? {
            PATH: `${fakeExecutables.binDir}${path.delimiter}${env.PATH ?? ""}`,
            T3CODE_E2E_PROCESS_LOG: fakeExecutables.logPath,
            HYPRLAND_INSTANCE_SIGNATURE: "t3code-e2e",
          }
        : {}),
      ...options.extraEnv,
      VITE_DEV_SERVER_URL: "",
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
    readLoggedProcessInvocations: () =>
      readLoggedProcessInvocations(fakeExecutables?.logPath ?? null),
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
        await removeFixtureWorktrees(repoDir);
        await fs.rm(repoDir, { recursive: true, force: true });
      }
      if (ownsT3Home) {
        await fs.rm(t3Home, { recursive: true, force: true });
      }
      if (fakeExecutables) {
        await fs.rm(fakeExecutables.binDir, { recursive: true, force: true });
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
    repoDir: process.repoDir,
    t3Home: process.t3Home,
    execGit: (args) => execGit(process.repoDir, args),
    readWorktreePath: (branch) => readWorktreePath(process.repoDir, branch),
    readLoggedProcessInvocations: process.readLoggedProcessInvocations,
    expectNoFatalLogs: process.expectNoFatalLogs,
    logs: process.logs,
    cleanup: process.cleanup,
  };
}
