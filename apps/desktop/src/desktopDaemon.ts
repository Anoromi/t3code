import * as FS from "node:fs";
import * as Net from "node:net";

import {
  DesktopDaemonControlRequest,
  type DesktopDaemonControlRequest as DesktopDaemonControlRequestType,
  type DesktopDaemonControlResponse as DesktopDaemonControlResponseType,
  type DesktopDaemonRecord,
} from "@t3tools/contracts";
import {
  canConnectToDesktopDaemon,
  ensureDesktopDaemonDir,
  removeDesktopDaemonArtifacts,
  sendDesktopDaemonControlRequest,
  type DesktopDaemonPaths,
} from "@t3tools/shared/desktopDaemon";
import { Schema } from "effect";

const decodeDesktopDaemonControlRequest = Schema.decodeUnknownSync(DesktopDaemonControlRequest);

export type DesktopDaemonController =
  | {
      readonly kind: "secondary";
    }
  | {
      readonly kind: "primary";
      readonly close: () => Promise<void>;
    };

async function listenOnControlEndpoint(controlEndpoint: string): Promise<Net.Server> {
  return new Promise((resolve, reject) => {
    const server = Net.createServer();
    server.once("error", (error) => {
      server.close();
      reject(error);
    });
    server.listen(controlEndpoint, () => {
      server.removeAllListeners("error");
      resolve(server);
    });
  });
}

async function closeServer(server: Net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function respond(socket: Net.Socket, payload: DesktopDaemonControlResponseType): void {
  socket.end(`${JSON.stringify(payload)}\n`);
}

function attachControlProtocol(server: Net.Server, onFocus: () => void | Promise<void>): void {
  server.on("connection", (socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex);
      buffer = "";

      let request: DesktopDaemonControlRequestType;
      try {
        request = decodeDesktopDaemonControlRequest(JSON.parse(line));
      } catch {
        respond(socket, { ok: false, error: "Invalid desktop daemon control request." });
        return;
      }

      if (request.type !== "focus") {
        respond(socket, {
          ok: false,
          error: `Unsupported desktop daemon request '${request.type}'.`,
        });
        return;
      }

      Promise.resolve(onFocus())
        .then(() => {
          respond(socket, { ok: true });
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          respond(socket, {
            ok: false,
            error: message.trim() || "Desktop daemon focus request failed.",
          });
        });
    });
    socket.on("error", () => {
      socket.destroy();
    });
  });
}

async function tryFocusExistingInstance(
  controlEndpoint: string,
): Promise<DesktopDaemonControlResponseType | null> {
  const endpointReachable = await canConnectToDesktopDaemon(controlEndpoint);
  if (!endpointReachable) {
    return null;
  }

  return sendDesktopDaemonControlRequest(controlEndpoint, { type: "focus" });
}

export async function acquireDesktopDaemonController(input: {
  readonly paths: DesktopDaemonPaths;
  readonly onFocus: () => void | Promise<void>;
  readonly platform?: NodeJS.Platform;
}): Promise<DesktopDaemonController> {
  const platform = input.platform ?? process.platform;
  const focusedExisting = await tryFocusExistingInstance(input.paths.controlEndpoint);
  if (focusedExisting?.ok) {
    return { kind: "secondary" };
  }
  if (focusedExisting && !focusedExisting.ok) {
    throw new Error(focusedExisting.error);
  }

  if (platform !== "win32") {
    const socketExists = FS.existsSync(input.paths.controlEndpoint);
    const socketReachable = await canConnectToDesktopDaemon(input.paths.controlEndpoint);
    if (socketExists && !socketReachable) {
      await removeDesktopDaemonArtifacts(input.paths, platform);
    }
  }

  try {
    await ensureDesktopDaemonDir(input.paths.daemonDir, platform);
    const server = await listenOnControlEndpoint(input.paths.controlEndpoint);
    attachControlProtocol(server, input.onFocus);
    return {
      kind: "primary",
      close: async () => {
        await closeServer(server);
        await removeDesktopDaemonArtifacts(input.paths, platform);
      },
    };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;

    if (code === "EADDRINUSE") {
      const retriedFocus = await tryFocusExistingInstance(input.paths.controlEndpoint);
      if (retriedFocus?.ok) {
        return { kind: "secondary" };
      }
      if (platform !== "win32") {
        await removeDesktopDaemonArtifacts(input.paths, platform);
        await ensureDesktopDaemonDir(input.paths.daemonDir, platform);
        const server = await listenOnControlEndpoint(input.paths.controlEndpoint);
        attachControlProtocol(server, input.onFocus);
        return {
          kind: "primary",
          close: async () => {
            await closeServer(server);
            await removeDesktopDaemonArtifacts(input.paths, platform);
          },
        };
      }
    }

    throw error;
  }
}

export function createDesktopDaemonRecord(input: {
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly baseDir: string;
  readonly stateDir: string;
  readonly wsUrl: string;
  readonly authToken: string;
  readonly controlEndpoint: string;
  readonly status: DesktopDaemonRecord["status"];
}): DesktopDaemonRecord {
  return {
    version: 1,
    kind: "desktop",
    instanceId: input.instanceId,
    pid: input.pid,
    startedAt: input.startedAt,
    baseDir: input.baseDir,
    stateDir: input.stateDir,
    wsUrl: input.wsUrl,
    authToken: input.authToken,
    controlEndpoint: input.controlEndpoint,
    status: input.status,
  };
}
