// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeTimersPromises from "node:timers/promises";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import {
  buildCorkdiffGhosttyArgs,
  createCorkdiffGhosttyClassName,
} from "./ExternalCorkdiffCommand.ts";

const COMMAND_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const CLIENT_READY_ATTEMPTS = 25;
const CLIENT_READY_DELAY_MS = 200;

export { buildCorkdiffGhosttyArgs, createCorkdiffGhosttyClassName };

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface HyprClient {
  readonly address?: unknown;
  readonly class?: unknown;
  readonly workspace?: { readonly id?: unknown };
}

interface CorkdiffClient {
  readonly address: string;
  readonly workspaceId: number;
}

export interface ExternalCorkdiffOpenInput {
  readonly cwd: string;
  readonly threadId: string;
}

export interface ExternalCorkdiffOpenResult {
  readonly workspaceId: number;
  readonly reused: boolean;
}

interface ExternalCorkdiffConnection {
  readonly serverUrl: string;
  readonly token: string;
}

interface ExternalCorkdiffSession {
  readonly className: string;
  readonly workspaceId: number;
}

export class ExternalCorkdiffCommandError extends Schema.TaggedErrorClass<ExternalCorkdiffCommandError>()(
  "ExternalCorkdiffCommandError",
  {
    operation: Schema.Literals(["inspect", "focus", "launch", "connection"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `External Corkdiff ${this.operation} failed.`;
  }
}

type RunCommand = (
  command: string,
  args: readonly string[],
  options?: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly resolveOnWorkspaceId?: boolean;
  },
) => Promise<CommandResult>;

function appendBounded(current: string, chunk: Buffer | string): string {
  if (Buffer.byteLength(current) >= MAX_OUTPUT_BYTES) return current;
  return (current + chunk.toString()).slice(0, MAX_OUTPUT_BYTES);
}

export function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly resolveOnWorkspaceId?: boolean;
  } = {},
): Promise<CommandResult> {
  const child = NodeChildProcess.spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const completion = new Promise<CommandResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const succeed = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = appendBounded(stdout, chunk);
      if (options.resolveOnWorkspaceId === true && parseWorkspaceId(stdout) !== null) {
        succeed({ code: null, stdout, stderr });
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", (cause) => {
      if (!settled) {
        settled = true;
        reject(cause);
      }
    });
    child.once("close", (code) => {
      succeed({ code, stdout, stderr });
    });
  });
  const timeoutController = new AbortController();
  const timeout = NodeTimersPromises.setTimeout(COMMAND_TIMEOUT_MS, undefined, {
    ref: false,
    signal: timeoutController.signal,
  }).then(() => {
    child.kill("SIGKILL");
    throw new Error(`${command} timed out after ${String(COMMAND_TIMEOUT_MS)}ms.`);
  });
  return Promise.race([completion, timeout]).finally(() => timeoutController.abort());
}

export function parseWorkspaceId(stdout: string): number | null {
  const firstLine = stdout
    .split(/\r?\n/u)
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (firstLine === undefined) return null;
  const parsed = Number(firstLine);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function findClientForClass(
  clients: readonly HyprClient[],
  className: string,
): CorkdiffClient | null {
  const match = clients.find((client) => client.class === className);
  const workspaceId = match?.workspace?.id;
  const address = match?.address;
  return typeof workspaceId === "number" &&
    Number.isSafeInteger(workspaceId) &&
    workspaceId > 0 &&
    typeof address === "string" &&
    address.trim().length > 0
    ? { address, workspaceId }
    : null;
}

export class ExternalCorkdiffManager {
  private readonly sessions = new Map<string, ExternalCorkdiffSession>();
  private readonly inFlight = new Map<string, Promise<ExternalCorkdiffOpenResult>>();
  private readonly run: RunCommand;
  private readonly runtimeEnv: NodeJS.ProcessEnv;
  private readonly readiness: {
    readonly attempts: number;
    readonly delayMs: number;
  };

  constructor(
    run: RunCommand,
    runtimeEnv: NodeJS.ProcessEnv,
    readiness = {
      attempts: CLIENT_READY_ATTEMPTS,
      delayMs: CLIENT_READY_DELAY_MS,
    },
  ) {
    this.run = run;
    this.runtimeEnv = runtimeEnv;
    this.readiness = readiness;
  }

  private async findClient(className: string): Promise<CorkdiffClient | null> {
    const clientsResult = await this.run("hyprctl", ["-j", "clients"]);
    if (clientsResult.code !== 0) {
      throw new Error(clientsResult.stderr.trim() || "hyprctl clients failed.");
    }
    const parsed: unknown = JSON.parse(clientsResult.stdout);
    return Array.isArray(parsed)
      ? findClientForClass(parsed as readonly HyprClient[], className)
      : null;
  }

  private async waitForClient(className: string): Promise<CorkdiffClient> {
    for (let attempt = 0; attempt < this.readiness.attempts; attempt += 1) {
      const client = await this.findClient(className);
      if (client !== null) return client;
      if (attempt + 1 < this.readiness.attempts) {
        await NodeTimersPromises.setTimeout(this.readiness.delayMs, undefined, {
          ref: false,
        });
      }
    }
    throw new Error("Corkdiff did not create a Ghostty window before the startup timeout.");
  }

  async focusExisting(threadId: string): Promise<ExternalCorkdiffOpenResult | null> {
    const pending = this.inFlight.get(threadId);
    if (pending !== undefined) {
      const result = await pending;
      return { ...result, reused: true };
    }

    const className = createCorkdiffGhosttyClassName(threadId);
    const client = await this.findClient(className);
    if (client === null) {
      this.sessions.delete(threadId);
      return null;
    }

    const focusResult = await this.run("hyprctl", [
      "dispatch",
      "workspace",
      String(client.workspaceId),
    ]);
    if (focusResult.code !== 0) {
      if ((await this.findClient(className)) === null) {
        this.sessions.delete(threadId);
        return null;
      }
      throw new Error(
        focusResult.stderr.trim() || `Failed to focus workspace ${String(client.workspaceId)}.`,
      );
    }
    const focusWindowResult = await this.run("hyprctl", [
      "dispatch",
      "focuswindow",
      `address:${client.address}`,
    ]);
    if (focusWindowResult.code !== 0) {
      if ((await this.findClient(className)) === null) {
        this.sessions.delete(threadId);
        return null;
      }
      throw new Error(focusWindowResult.stderr.trim() || "Failed to focus Corkdiff.");
    }
    this.sessions.set(threadId, { className, workspaceId: client.workspaceId });
    return { workspaceId: client.workspaceId, reused: true };
  }

  async launch(
    input: ExternalCorkdiffOpenInput,
    connection: ExternalCorkdiffConnection,
  ): Promise<ExternalCorkdiffOpenResult> {
    const pending = this.inFlight.get(input.threadId);
    if (pending !== undefined) {
      const result = await pending;
      return { ...result, reused: true };
    }

    const launchPromise = this.launchFresh(input, connection);
    this.inFlight.set(input.threadId, launchPromise);
    try {
      return await launchPromise;
    } finally {
      if (this.inFlight.get(input.threadId) === launchPromise) {
        this.inFlight.delete(input.threadId);
      }
    }
  }

  private async launchFresh(
    input: ExternalCorkdiffOpenInput,
    connection: ExternalCorkdiffConnection,
  ): Promise<ExternalCorkdiffOpenResult> {
    const className = createCorkdiffGhosttyClassName(input.threadId);
    const result = await this.run(
      "hyprnav",
      [
        "spawn",
        "--print-workspace-id",
        "rand",
        "--",
        "ghostty",
        ...buildCorkdiffGhosttyArgs({ className, threadId: input.threadId }),
      ],
      {
        cwd: input.cwd,
        env: {
          ...this.runtimeEnv,
          T3CODE_SERVER_URL: connection.serverUrl,
          T3CODE_TOKEN: connection.token,
          T3CODE_THREAD_ID: input.threadId,
        },
        resolveOnWorkspaceId: true,
      },
    );
    if (result.code !== 0 && result.code !== null) {
      throw new Error(result.stderr.trim() || "hyprnav spawn failed.");
    }
    const workspaceId = parseWorkspaceId(result.stdout);
    if (workspaceId === null) {
      throw new Error("hyprnav did not return a valid workspace id.");
    }
    const client = await this.waitForClient(className);
    this.sessions.set(input.threadId, {
      className,
      workspaceId: client.workspaceId,
    });
    return { workspaceId: client.workspaceId, reused: false };
  }
}

export class ExternalCorkdiff extends Context.Service<
  ExternalCorkdiff,
  {
    readonly openOrFocus: (
      input: ExternalCorkdiffOpenInput,
    ) => Effect.Effect<ExternalCorkdiffOpenResult, ExternalCorkdiffCommandError>;
  }
>()("@t3tools/desktop/corkdiff/ExternalCorkdiff") {}

function toWebSocketUrl(httpBaseUrl: URL): string {
  const url = new URL(httpBaseUrl.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.href;
}

export const make = Effect.gen(function* () {
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
  const manager = new ExternalCorkdiffManager(runCommand, process.env);

  const openOrFocus = Effect.fn("desktop.corkdiff.openOrFocus")(function* (
    input: ExternalCorkdiffOpenInput,
  ) {
    const existing = yield* Effect.tryPromise({
      try: () => manager.focusExisting(input.threadId),
      catch: (cause) => new ExternalCorkdiffCommandError({ operation: "inspect", cause }),
    });
    if (existing !== null) return existing;

    const primary = yield* pool.primary;
    const config = yield* primary.currentConfig;
    if (Option.isNone(config)) {
      return yield* new ExternalCorkdiffCommandError({
        operation: "connection",
        cause: new Error("Primary desktop backend is not configured."),
      });
    }
    const token = yield* auth.getBearerToken.pipe(
      Effect.mapError(
        (cause) => new ExternalCorkdiffCommandError({ operation: "connection", cause }),
      ),
    );
    return yield* Effect.tryPromise({
      try: () =>
        manager.launch(input, {
          serverUrl: toWebSocketUrl(config.value.httpBaseUrl),
          token,
        }),
      catch: (cause) => new ExternalCorkdiffCommandError({ operation: "launch", cause }),
    });
  });

  return ExternalCorkdiff.of({ openOrFocus });
});

export const layer = Layer.effect(ExternalCorkdiff, make);
