import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Net from "node:net";
import * as OS from "node:os";
import * as Path from "node:path";

import {
  DesktopDaemonControlResponse,
  DesktopDaemonRecord,
  type DesktopDaemonControlRequest as DesktopDaemonControlRequestType,
  type DesktopDaemonControlResponse as DesktopDaemonControlResponseType,
  type DesktopDaemonRecord as DesktopDaemonRecordType,
  type DesktopDaemonStatus,
} from "@t3tools/contracts";
import { Schema } from "effect";

export type DesktopDaemonPaths = {
  readonly stateDir: string;
  readonly daemonDir: string;
  readonly recordPath: string;
  readonly controlEndpoint: string;
};

const DEFAULT_CONTROL_TIMEOUT_MS = 1_000;

const decodeDesktopDaemonRecord = Schema.decodeUnknownSync(DesktopDaemonRecord);
const decodeDesktopDaemonControlResponse = Schema.decodeUnknownSync(DesktopDaemonControlResponse);

export function resolveDesktopStateDir(input?: {
  readonly baseDir?: string;
  readonly stateDirOverride?: string | null | undefined;
  readonly homeDir?: string;
}): string {
  const baseDir = input?.baseDir?.trim() || Path.join(input?.homeDir ?? OS.homedir(), ".t3");
  const configuredStateDir = input?.stateDirOverride?.trim();
  if (configuredStateDir) {
    return Path.resolve(configuredStateDir);
  }
  return Path.join(baseDir, "userdata");
}

export function resolveDesktopDaemonPaths(
  stateDir: string,
  platform: NodeJS.Platform = process.platform,
): DesktopDaemonPaths {
  const normalizedStateDir = Path.resolve(stateDir);
  const daemonDir = Path.join(normalizedStateDir, "daemon");
  const recordPath = Path.join(daemonDir, "desktop.json");
  const controlEndpoint =
    platform === "win32"
      ? `\\\\.\\pipe\\t3code-desktop-${Crypto.createHash("sha256").update(normalizedStateDir).digest("hex").slice(0, 16)}`
      : Path.join(daemonDir, "desktop.sock");

  return {
    stateDir: normalizedStateDir,
    daemonDir,
    recordPath,
    controlEndpoint,
  };
}

export async function ensureDesktopDaemonDir(
  daemonDir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await FS.promises.mkdir(daemonDir, { recursive: true });
  if (platform !== "win32") {
    await FS.promises.chmod(daemonDir, 0o700).catch(() => {});
  }
}

export async function writeDesktopDaemonRecord(
  paths: DesktopDaemonPaths,
  record: DesktopDaemonRecordType,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await ensureDesktopDaemonDir(paths.daemonDir, platform);
  const tempPath = Path.join(
    paths.daemonDir,
    `.desktop.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await FS.promises.writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  if (platform !== "win32") {
    await FS.promises.chmod(tempPath, 0o600).catch(() => {});
  }
  await FS.promises.rename(tempPath, paths.recordPath);
  if (platform !== "win32") {
    await FS.promises.chmod(paths.recordPath, 0o600).catch(() => {});
  }
}

export async function readDesktopDaemonRecord(
  recordPath: string,
): Promise<DesktopDaemonRecordType | null> {
  try {
    const raw = await FS.promises.readFile(recordPath, "utf8");
    return decodeDesktopDaemonRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function isDesktopDaemonProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    ) {
      return true;
    }
    return false;
  }
}

export async function removeDesktopDaemonArtifacts(
  paths: DesktopDaemonPaths,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await FS.promises.rm(paths.recordPath, { force: true }).catch(() => {});
  if (platform !== "win32") {
    await FS.promises.rm(paths.controlEndpoint, { force: true }).catch(() => {});
  }
}

export function isDesktopDaemonReady(record: DesktopDaemonRecordType): boolean {
  return record.status === ("ready" satisfies DesktopDaemonStatus);
}

export async function canConnectToDesktopDaemon(
  controlEndpoint: string,
  timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = Net.createConnection(controlEndpoint);
    let settled = false;

    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function sendDesktopDaemonControlRequest(
  controlEndpoint: string,
  request: DesktopDaemonControlRequestType,
  timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS,
): Promise<DesktopDaemonControlResponseType> {
  return new Promise((resolve, reject) => {
    const socket = Net.createConnection(controlEndpoint);
    let settled = false;
    let buffer = "";

    const finish = (handler: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      handler();
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex);
      finish(() => {
        try {
          resolve(decodeDesktopDaemonControlResponse(JSON.parse(line)));
        } catch (error) {
          reject(error);
        }
      });
    });
    socket.once("timeout", () => {
      finish(() =>
        reject(new Error(`Timed out connecting to desktop daemon at ${controlEndpoint}.`)),
      );
    });
    socket.once("error", (error) => {
      finish(() => reject(error));
    });
    socket.once("end", () => {
      if (settled) return;
      finish(() =>
        reject(new Error(`Desktop daemon at ${controlEndpoint} closed without a response.`)),
      );
    });
  });
}

export async function readLiveDesktopDaemonRecord(
  paths: DesktopDaemonPaths,
  options?: {
    readonly cleanupStale?: boolean;
    readonly platform?: NodeJS.Platform;
    readonly timeoutMs?: number;
  },
): Promise<DesktopDaemonRecordType | null> {
  const platform = options?.platform ?? process.platform;
  const record = await readDesktopDaemonRecord(paths.recordPath);
  if (!record) {
    const endpointReachable = await canConnectToDesktopDaemon(
      paths.controlEndpoint,
      options?.timeoutMs,
    );
    if (!endpointReachable && options?.cleanupStale) {
      await removeDesktopDaemonArtifacts(paths, platform);
    }
    return null;
  }

  const processAlive = isDesktopDaemonProcessAlive(record.pid);
  const endpointReachable = await canConnectToDesktopDaemon(
    record.controlEndpoint,
    options?.timeoutMs,
  );
  if (processAlive && endpointReachable) {
    return record;
  }

  if (options?.cleanupStale) {
    await removeDesktopDaemonArtifacts(paths, platform);
  }
  return null;
}

export async function waitForReadyDesktopDaemonRecord(
  paths: DesktopDaemonPaths,
  options?: {
    readonly cleanupStale?: boolean;
    readonly platform?: NodeJS.Platform;
    readonly timeoutMs?: number;
    readonly pollIntervalMs?: number;
  },
): Promise<DesktopDaemonRecordType | null> {
  const timeoutMs = options?.timeoutMs ?? 5_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const readOptions: {
      cleanupStale?: boolean;
      platform?: NodeJS.Platform;
      timeoutMs: number;
    } = {
      timeoutMs: Math.min(DEFAULT_CONTROL_TIMEOUT_MS, pollIntervalMs),
    };
    if (options?.cleanupStale !== undefined) {
      readOptions.cleanupStale = options.cleanupStale;
    }
    if (options?.platform !== undefined) {
      readOptions.platform = options.platform;
    }
    const record = await readLiveDesktopDaemonRecord(paths, readOptions);
    if (record && isDesktopDaemonReady(record)) {
      return record;
    }
    if (record === null && !options?.cleanupStale) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const finalReadOptions: {
    cleanupStale?: boolean;
    platform?: NodeJS.Platform;
    timeoutMs: number;
  } = {
    timeoutMs: DEFAULT_CONTROL_TIMEOUT_MS,
  };
  if (options?.cleanupStale !== undefined) {
    finalReadOptions.cleanupStale = options.cleanupStale;
  }
  if (options?.platform !== undefined) {
    finalReadOptions.platform = options.platform;
  }
  return readLiveDesktopDaemonRecord(paths, finalReadOptions).then((record) =>
    record && isDesktopDaemonReady(record) ? record : null,
  );
}
