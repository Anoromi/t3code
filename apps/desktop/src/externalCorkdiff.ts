import * as ChildProcess from "node:child_process";
import { createHash } from "node:crypto";

import type { BrowserWindow } from "electron";

export interface ExternalCorkdiffToggleInput {
  readonly cwd: string;
  readonly serverUrl: string;
  readonly token: string | null;
  readonly threadId: string;
}

export interface ExternalCorkdiffToggleResult {
  readonly workspaceId: number;
  readonly reused: boolean;
}

export interface ExternalCorkdiffSession {
  readonly threadId: string;
  readonly cwd: string;
  readonly className: string;
  readonly workspaceId: number;
  readonly launcherProcess: ChildProcess.ChildProcess;
  readonly createdAt: number;
  readonly status: "launching" | "running";
  readonly launchPromise: Promise<ExternalCorkdiffToggleResult>;
}

interface HyprClient {
  readonly class?: unknown;
  readonly pid?: unknown;
  readonly workspace?: {
    readonly id?: unknown;
  };
}

const CORKDIFF_GHOSTTY_CLASS_PREFIX = "dev.t3tools.t3code.corkdiff";

interface ExternalCorkdiffManagerDeps {
  readonly spawn: typeof ChildProcess.spawn;
  readonly spawnSync: typeof ChildProcess.spawnSync;
  readonly now: () => number;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly runtimeEnv: NodeJS.ProcessEnv;
}

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildCorkdiffLaunchCommand(input: {
  readonly serverUrl: string;
  readonly token: string | null;
  readonly threadId: string;
}): string {
  const envAssignments = [`T3CODE_SERVER_URL=${quoteShellArg(input.serverUrl)}`];
  if (input.token) {
    envAssignments.push(`T3CODE_TOKEN=${quoteShellArg(input.token)}`);
  }

  const command = [
    `CorkDiff t3code ${input.threadId}`,
    "lua vim.defer_fn(function() if vim.fn.tabpagenr('$') > 1 then local current = vim.api.nvim_get_current_tabpage() vim.cmd('tabfirst') if vim.api.nvim_get_current_tabpage() ~= current then vim.cmd('tabclose') end end end, 100)",
  ].join(" | ");

  return `exec env ${envAssignments.join(" ")} nvim -c ${quoteShellArg(command)}`;
}

export function createCorkdiffGhosttyClassName(threadId: string): string {
  const suffix = createHash("sha256").update(threadId).digest("hex").slice(0, 12);
  return `${CORKDIFF_GHOSTTY_CLASS_PREFIX}.t${suffix}`;
}

export function buildCorkdiffGhosttyArgs(input: {
  readonly className: string;
  readonly serverUrl: string;
  readonly token: string | null;
  readonly threadId: string;
}): readonly string[] {
  return [
    "--gtk-single-instance=false",
    `--class=${input.className}`,
    `--title=T3 Code Corkdiff ${input.threadId}`,
    "-e",
    "sh",
    "-lc",
    buildCorkdiffLaunchCommand(input),
  ];
}

export function buildCorkdiffHyprctlExecCommand(input: {
  readonly className: string;
  readonly cwd: string;
  readonly serverUrl: string;
  readonly token: string | null;
  readonly threadId: string;
}): string {
  return [
    "sh",
    "-lc",
    quoteShellArg(
      [
        "cd",
        quoteShellArg(input.cwd),
        "&&",
        "exec",
        "ghostty",
        ...buildCorkdiffGhosttyArgs(input).map((arg) => quoteShellArg(arg)),
      ].join(" "),
    ),
  ].join(" ");
}

export function parseWorkspaceId(rawValue: string): number | null {
  const normalized = rawValue.trim();
  if (normalized.length === 0) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function extractWorkspaceIdFromStdout(stdout: string): number | null {
  for (const line of stdout.split(/\r?\n/u)) {
    const workspaceId = parseWorkspaceId(line);
    if (workspaceId !== null) {
      return workspaceId;
    }
    if (line.trim().length > 0) {
      return null;
    }
  }
  return null;
}

export function extractWorkspaceIdForHyprnavSpawnSocketFallback(input: {
  readonly stdout: string;
  readonly stderr: string;
}): number | null {
  if (
    !input.stderr.includes("request_failed: connecting to") ||
    !input.stderr.includes("/spawn.sock")
  ) {
    return null;
  }

  return extractWorkspaceIdFromStdout(input.stdout);
}

export function getAppWorkspaceCandidatePids(mainWindow: BrowserWindow | null): number[] {
  const candidatePids = new Set<number>();
  if (process.pid > 0) {
    candidatePids.add(process.pid);
  }

  const rendererPid = mainWindow?.webContents.getOSProcessId();
  if (typeof rendererPid === "number" && Number.isInteger(rendererPid) && rendererPid > 0) {
    candidatePids.add(rendererPid);
  }

  return [...candidatePids];
}

export function findHyprWorkspaceForPids(
  clients: readonly HyprClient[],
  candidatePids: readonly number[],
): number | null {
  if (candidatePids.length === 0) {
    return null;
  }

  for (const pid of candidatePids) {
    const match = clients.find(
      (client) =>
        client.pid === pid &&
        typeof client.workspace?.id === "number" &&
        Number.isInteger(client.workspace.id) &&
        client.workspace.id > 0,
    );
    if (typeof match?.workspace?.id === "number") {
      return match.workspace.id;
    }
  }

  return null;
}

export function findHyprWorkspaceForClassName(
  clients: readonly HyprClient[],
  className: string,
): number | null {
  for (const client of clients) {
    if (
      client.class === className &&
      typeof client.workspace?.id === "number" &&
      Number.isInteger(client.workspace.id) &&
      client.workspace.id > 0
    ) {
      return client.workspace.id;
    }
  }

  return null;
}

function listHyprClients(
  spawnSyncImpl: typeof ChildProcess.spawnSync,
): readonly HyprClient[] | null {
  const result = spawnSyncImpl("hyprctl", ["-j", "clients"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? (parsed as HyprClient[]) : null;
  } catch {
    return null;
  }
}

function dispatchHyprWorkspace(
  spawnSyncImpl: typeof ChildProcess.spawnSync,
  workspaceId: number,
): void {
  const result = spawnSyncImpl("hyprctl", ["dispatch", "workspace", String(workspaceId)], {
    stdio: "ignore",
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Failed to focus Hypr workspace ${String(workspaceId)}.`);
  }
}

function dispatchHyprExec(spawnSyncImpl: typeof ChildProcess.spawnSync, command: string): void {
  const result = spawnSyncImpl("hyprctl", ["dispatch", "exec", command], {
    stdio: "ignore",
  });
  if (result.error || result.status !== 0) {
    throw new Error("Failed to launch external Corkdiff through Hyprland.");
  }
}

function formatExitFailure(input: {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}): string {
  if (input.stderr.length > 0) {
    return input.stderr;
  }
  if (input.signal) {
    return `launcher exited with signal ${input.signal}`;
  }
  if (typeof input.code === "number") {
    return `launcher exited with code ${String(input.code)}`;
  }
  return "launcher exited unexpectedly";
}

function isLiveProcess(processHandle: ChildProcess.ChildProcess): boolean {
  return (
    processHandle.exitCode === null && processHandle.signalCode === null && !processHandle.killed
  );
}

export class ExternalCorkdiffManager {
  private readonly sessions = new Map<string, ExternalCorkdiffSession>();
  private readonly deps: ExternalCorkdiffManagerDeps;

  constructor(deps: ExternalCorkdiffManagerDeps) {
    this.deps = deps;
  }

  async toggle(input: ExternalCorkdiffToggleInput): Promise<ExternalCorkdiffToggleResult> {
    const existing = this.sessions.get(input.threadId);
    if (existing) {
      if (existing.status === "launching") {
        const result = await existing.launchPromise;
        this.focusWorkspace(result.workspaceId);
        return { workspaceId: result.workspaceId, reused: true };
      }

      const liveWorkspaceId = this.resolveWorkspaceForClassName(existing.className);
      if (liveWorkspaceId !== null) {
        this.focusWorkspace(liveWorkspaceId);
        return { workspaceId: liveWorkspaceId, reused: true };
      }

      if (isLiveProcess(existing.launcherProcess) && existing.workspaceId > 0) {
        this.focusWorkspace(existing.workspaceId);
        return { workspaceId: existing.workspaceId, reused: true };
      }

      this.sessions.delete(input.threadId);
    }

    return this.launch(input);
  }

  focusAppWindow(): void {
    const mainWindow = this.deps.getMainWindow();
    const workspaceId = this.resolveCurrentAppWorkspaceId(mainWindow);
    if (workspaceId !== null) {
      this.focusWorkspace(workspaceId);
    }
    mainWindow?.show();
    mainWindow?.focus();
  }

  private resolveCurrentAppWorkspaceId(mainWindow: BrowserWindow | null): number | null {
    const clients = listHyprClients(this.deps.spawnSync);
    if (!clients) {
      return null;
    }
    return findHyprWorkspaceForPids(clients, getAppWorkspaceCandidatePids(mainWindow));
  }

  private focusWorkspace(workspaceId: number): void {
    dispatchHyprWorkspace(this.deps.spawnSync, workspaceId);
  }

  private resolveWorkspaceForClassName(className: string): number | null {
    const clients = listHyprClients(this.deps.spawnSync);
    if (!clients) {
      return null;
    }
    return findHyprWorkspaceForClassName(clients, className);
  }

  private async launch(input: ExternalCorkdiffToggleInput): Promise<ExternalCorkdiffToggleResult> {
    if (input.cwd.trim().length === 0) {
      throw new Error("External Corkdiff launch requires a valid working directory.");
    }
    if (input.serverUrl.trim().length === 0) {
      throw new Error("External Corkdiff launch requires a valid t3code websocket URL.");
    }
    if (input.threadId.trim().length === 0) {
      throw new Error("External Corkdiff launch requires a valid t3code thread id.");
    }

    const className = createCorkdiffGhosttyClassName(input.threadId);
    const child = this.deps.spawn(
      "hyprnav",
      [
        "spawn",
        "--print-workspace-id",
        "rand",
        "--",
        "ghostty",
        ...buildCorkdiffGhosttyArgs({ ...input, className }),
      ],
      {
        cwd: input.cwd,
        env: this.deps.runtimeEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    let settled = false;
    let stdoutBuffer = "";
    const stderrChunks: string[] = [];

    const launchPromise = new Promise<ExternalCorkdiffToggleResult>((resolve, reject) => {
      const settle = (result: ExternalCorkdiffToggleResult | null, error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          this.sessions.delete(input.threadId);
          reject(error);
          return;
        }
        if (!result) {
          this.sessions.delete(input.threadId);
          reject(new Error("External Corkdiff launch did not produce a workspace id."));
          return;
        }
        resolve(result);
      };

      const tryParseWorkspaceId = () => {
        const workspaceId = extractWorkspaceIdFromStdout(stdoutBuffer);
        if (workspaceId === null) {
          return;
        }
        const existing = this.sessions.get(input.threadId);
        if (existing && existing.launcherProcess === child) {
          this.sessions.set(input.threadId, {
            ...existing,
            workspaceId,
            status: "running",
          });
        }
        settle({ workspaceId, reused: false });
      };

      child.stdout?.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        if (!settled) {
          tryParseWorkspaceId();
        }
      });

      child.stderr?.on("data", (chunk: string) => {
        stderrChunks.push(chunk);
      });

      child.once("error", (error) => {
        settle(
          null,
          new Error(`Failed to start external Corkdiff: ${error.message}`, { cause: error }),
        );
      });

      child.once("exit", (code, signal) => {
        const existing = this.sessions.get(input.threadId);
        const fallbackWorkspaceId = extractWorkspaceIdForHyprnavSpawnSocketFallback({
          stdout: stdoutBuffer,
          stderr: stderrChunks.join("").trim(),
        });
        if (fallbackWorkspaceId !== null) {
          try {
            this.focusWorkspace(fallbackWorkspaceId);
            dispatchHyprExec(
              this.deps.spawnSync,
              buildCorkdiffHyprctlExecCommand({ ...input, className }),
            );
            if (existing?.launcherProcess === child) {
              this.sessions.set(input.threadId, {
                ...existing,
                workspaceId: fallbackWorkspaceId,
                status: "running",
              });
            }
            settle({ workspaceId: fallbackWorkspaceId, reused: false });
          } catch (error) {
            settle(
              null,
              error instanceof Error
                ? error
                : new Error("Failed to launch external Corkdiff fallback."),
            );
          }
          return;
        }
        if (!settled && existing?.launcherProcess === child) {
          this.sessions.delete(input.threadId);
        }
        if (!settled) {
          settle(
            null,
            new Error(
              `External Corkdiff exited before launch completed: ${formatExitFailure({
                code,
                signal,
                stderr: stderrChunks.join("").trim(),
              })}`,
            ),
          );
        }
      });
    });

    this.sessions.set(input.threadId, {
      threadId: input.threadId,
      cwd: input.cwd,
      className,
      workspaceId: -1,
      launcherProcess: child,
      createdAt: this.deps.now(),
      status: "launching",
      launchPromise,
    });

    const result = await launchPromise;
    this.focusWorkspace(result.workspaceId);
    return result;
  }
}

export function createExternalCorkdiffManager(input: {
  readonly getMainWindow: () => BrowserWindow | null;
  readonly runtimeEnv: NodeJS.ProcessEnv;
}): ExternalCorkdiffManager {
  return new ExternalCorkdiffManager({
    spawn: ChildProcess.spawn,
    spawnSync: ChildProcess.spawnSync,
    now: Date.now,
    getMainWindow: input.getMainWindow,
    runtimeEnv: input.runtimeEnv,
  });
}
