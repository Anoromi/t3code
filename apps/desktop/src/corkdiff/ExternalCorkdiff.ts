// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeTimersPromises from "node:timers/promises";

import { issueRemoteWebSocketTicket } from "@t3tools/client-runtime/authorization";
import { EnvironmentAuthInvalidError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import {
  buildCorkdiffConnectionUpdateExpression,
  buildCorkdiffGhosttyArgs,
  createCorkdiffGhosttyClassName,
  createCorkdiffNvimServerAddress,
} from "./ExternalCorkdiffCommand.ts";

export {
  buildCorkdiffConnectionUpdateExpression,
  buildCorkdiffGhosttyArgs,
  createCorkdiffGhosttyClassName,
  createCorkdiffNvimServerAddress,
};

const COMMAND_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const WORKSPACE_ID_SETTLE_MS = 150;
const CLIENT_READY_ATTEMPTS = 25;
const CLIENT_READY_DELAY_MS = 200;
const CREDENTIAL_REFRESH_SKEW_MS = 30_000;
const CREDENTIAL_REFRESH_RETRY_MS = 10_000;
const isEnvironmentAuthInvalidError = Schema.is(EnvironmentAuthInvalidError);

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
  readonly expiresAtMs: number;
}

interface ExternalCorkdiffSession {
  readonly generation: number;
  readonly className: string;
  readonly nvimServerAddress: string;
  readonly workspaceId: number;
  readonly credentialRefreshFailed: boolean;
}

export type ExternalCorkdiffCredentialRefreshResult = "refreshed" | "closed";

export class ExternalCorkdiffCommandError extends Schema.TaggedErrorClass<ExternalCorkdiffCommandError>()(
  "ExternalCorkdiffCommandError",
  {
    operation: Schema.Literals(["inspect", "focus", "launch", "connection"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const detail =
      this.cause instanceof Error
        ? this.cause.message.trim()
        : typeof this.cause === "string"
          ? this.cause.trim()
          : "";
    return `External Corkdiff ${this.operation} failed${detail ? `: ${detail}` : "."}`;
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
        // `hyprnav spawn --print-workspace-id` prints before contacting the
        // compositor plugin. Keep a short failure window so a missing/broken
        // spawn socket is reported instead of being masked as a client timeout.
        void NodeTimersPromises.setTimeout(WORKSPACE_ID_SETTLE_MS, undefined, { ref: false }).then(
          () => succeed({ code: null, stdout, stderr }),
        );
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

export function buildCorkdiffTicketUpdateExpression(ticket: string): string {
  if (!/^[A-Za-z0-9._~-]+$/u.test(ticket)) {
    throw new Error("Websocket ticket contains unsupported characters.");
  }
  return `luaeval("(function(token) require('codediff.config').options.t3code.token = token return true end)(_A)", "${ticket}")`;
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

export function buildCorkdiffEnvironment(
  runtimeEnv: NodeJS.ProcessEnv,
  input: ExternalCorkdiffOpenInput,
  connection: ExternalCorkdiffConnection,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...runtimeEnv,
    T3CODE_SERVER_URL: connection.serverUrl,
    T3CODE_TOKEN: connection.token,
    T3CODE_THREAD_ID: input.threadId,
  };
  // T3CODE_TOKEN is a short-lived websocket ticket, never the cached bearer
  // token. Corkdiff already redacts this query parameter from diagnostics.
  return env;
}

export function credentialRefreshDelayMs(nowMs: number, expiresAtMs: number): number {
  return Math.max(0, expiresAtMs - CREDENTIAL_REFRESH_SKEW_MS - nowMs);
}

export function issueCorkdiffWebSocketTicketWithBearerRetry<
  Ticket,
  BearerError,
  TicketError,
>(input: {
  readonly getBearerToken: Effect.Effect<string, BearerError>;
  readonly invalidateBearerToken: Effect.Effect<void>;
  readonly issueTicket: (bearerToken: string) => Effect.Effect<Ticket, TicketError>;
  readonly shouldInvalidateBearer: (error: TicketError) => boolean;
}): Effect.Effect<Ticket, BearerError | TicketError> {
  return Effect.gen(function* () {
    const bearerToken = yield* input.getBearerToken;
    return yield* input.issueTicket(bearerToken).pipe(
      Effect.catch((error) =>
        input.shouldInvalidateBearer(error)
          ? Effect.gen(function* () {
              yield* input.invalidateBearerToken;
              return yield* input.issueTicket(yield* input.getBearerToken);
            })
          : Effect.fail(error),
      ),
    );
  });
}

export const runExternalCorkdiffCredentialRefreshLoop = Effect.fn(
  "desktop.corkdiff.runCredentialRefreshLoop",
)(function* (input: {
  readonly initialExpiresAtMs: number;
  readonly isCurrent: () => boolean;
  readonly resolveConnection: () => Effect.Effect<
    ExternalCorkdiffConnection,
    ExternalCorkdiffCommandError
  >;
  readonly refresh: (
    connection: ExternalCorkdiffConnection,
  ) => Promise<ExternalCorkdiffCredentialRefreshResult>;
}) {
  let expiresAtMs = input.initialExpiresAtMs;
  while (input.isCurrent()) {
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.sleep(Duration.millis(credentialRefreshDelayMs(now, expiresAtMs)));
    if (!input.isCurrent()) return;

    const connection = yield* input.resolveConnection().pipe(
      Effect.tapCause((cause) =>
        Effect.logError("failed to refresh external Corkdiff websocket ticket", cause),
      ),
      Effect.option,
    );
    if (Option.isNone(connection)) {
      yield* Effect.sleep(Duration.millis(CREDENTIAL_REFRESH_RETRY_MS));
      continue;
    }
    const refreshed = yield* Effect.tryPromise({
      try: () => input.refresh(connection.value),
      catch: (cause) => new ExternalCorkdiffCommandError({ operation: "launch", cause }),
    }).pipe(
      Effect.tapCause((cause) =>
        Effect.logError("failed to refresh external Corkdiff websocket ticket", cause),
      ),
      Effect.option,
    );
    if (Option.isNone(refreshed)) {
      yield* Effect.sleep(Duration.millis(CREDENTIAL_REFRESH_RETRY_MS));
      continue;
    }
    if (refreshed.value === "closed") return;
    expiresAtMs = connection.value.expiresAtMs;
  }
});

export class ExternalCorkdiffManager {
  private readonly sessions = new Map<string, ExternalCorkdiffSession>();
  private readonly inFlight = new Map<string, Promise<ExternalCorkdiffOpenResult>>();
  private nextSessionGeneration = 0;
  private readonly run: RunCommand;
  private readonly runtimeEnv: NodeJS.ProcessEnv;
  private readonly readiness: { readonly attempts: number; readonly delayMs: number };

  constructor(
    run: RunCommand,
    runtimeEnv: NodeJS.ProcessEnv,
    readiness = { attempts: CLIENT_READY_ATTEMPTS, delayMs: CLIENT_READY_DELAY_MS },
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

  private updateSessionIfCurrent(
    threadId: string,
    generation: number,
    update: (session: ExternalCorkdiffSession) => ExternalCorkdiffSession,
  ): ExternalCorkdiffSession | null {
    const current = this.sessions.get(threadId);
    if (current?.generation !== generation) return null;
    const next = update(current);
    this.sessions.set(threadId, next);
    return next;
  }

  private deleteSessionIfCurrent(threadId: string, generation: number): void {
    if (this.sessions.get(threadId)?.generation === generation) {
      this.sessions.delete(threadId);
    }
  }

  private async waitForClient(className: string): Promise<CorkdiffClient> {
    for (let attempt = 0; attempt < this.readiness.attempts; attempt += 1) {
      const client = await this.findClient(className);
      if (client !== null) return client;
      if (attempt + 1 < this.readiness.attempts) {
        await NodeTimersPromises.setTimeout(this.readiness.delayMs, undefined, { ref: false });
      }
    }
    throw new Error("Corkdiff did not create a Ghostty window before the startup timeout.");
  }

  private async closeClient(className: string, client: CorkdiffClient): Promise<void> {
    const closeResult = await this.run("hyprctl", [
      "dispatch",
      "closewindow",
      `address:${client.address}`,
    ]);
    if (closeResult.code !== 0) {
      throw new Error(closeResult.stderr.trim() || "Failed to close stale Corkdiff.");
    }
    for (let attempt = 0; attempt < this.readiness.attempts; attempt += 1) {
      const remainingClient = await this.findClient(className);
      if (remainingClient === null || remainingClient.address !== client.address) return;
      if (attempt + 1 < this.readiness.attempts) {
        await NodeTimersPromises.setTimeout(this.readiness.delayMs, undefined, { ref: false });
      }
    }
    throw new Error("Stale Corkdiff did not close before its replacement timeout.");
  }

  async focusExisting(
    threadId: string,
    connection?: ExternalCorkdiffConnection,
  ): Promise<ExternalCorkdiffOpenResult | null> {
    const pending = this.inFlight.get(threadId);
    if (pending !== undefined) {
      const result = await pending;
      return { ...result, reused: true };
    }

    const className = createCorkdiffGhosttyClassName(threadId);
    const sessionBeforeInspection = this.sessions.get(threadId);
    const client = await this.findClient(className);
    if (client === null) {
      if (sessionBeforeInspection !== undefined) {
        this.deleteSessionIfCurrent(threadId, sessionBeforeInspection.generation);
      }
      return null;
    }
    const inspectedSession = this.sessions.get(threadId);
    let session = inspectedSession;
    if (connection) {
      const nvimServerAddress =
        session?.nvimServerAddress ?? createCorkdiffNvimServerAddress(threadId, this.runtimeEnv);
      let updateResult: CommandResult;
      try {
        updateResult = await this.run("nvim", [
          "--server",
          nvimServerAddress,
          "--remote-expr",
          buildCorkdiffConnectionUpdateExpression(connection),
        ]);
      } catch {
        if (
          inspectedSession !== undefined &&
          this.sessions.get(threadId)?.generation !== inspectedSession.generation
        ) {
          return null;
        }
        await this.closeClient(className, client);
        if (inspectedSession !== undefined) {
          this.deleteSessionIfCurrent(threadId, inspectedSession.generation);
        }
        return null;
      }
      if (updateResult.code === 0) {
        const generation = session?.generation ?? ++this.nextSessionGeneration;
        session = {
          generation,
          className,
          nvimServerAddress,
          workspaceId: client.workspaceId,
          credentialRefreshFailed: false,
        };
        this.sessions.set(threadId, session);
      } else {
        session = undefined;
      }
    }
    if (session?.credentialRefreshFailed === true && !connection) return null;
    if (session === undefined) {
      if (!connection) return null;
      if (
        inspectedSession !== undefined &&
        this.sessions.get(threadId)?.generation !== inspectedSession.generation
      ) {
        return null;
      }
      await this.closeClient(className, client);
      if (inspectedSession !== undefined) {
        this.deleteSessionIfCurrent(threadId, inspectedSession.generation);
      }
      return null;
    }

    const focusResult = await this.run("hyprctl", [
      "dispatch",
      "workspace",
      String(client.workspaceId),
    ]);
    if (focusResult.code !== 0) {
      if ((await this.findClient(className)) === null) {
        this.deleteSessionIfCurrent(threadId, session.generation);
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
        this.deleteSessionIfCurrent(threadId, session.generation);
        return null;
      }
      throw new Error(focusWindowResult.stderr.trim() || "Failed to focus Corkdiff.");
    }
    this.updateSessionIfCurrent(threadId, session.generation, (current) => ({
      ...current,
      className,
      workspaceId: client.workspaceId,
    }));
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

  async refreshCredential(
    threadId: string,
    connection: ExternalCorkdiffConnection,
  ): Promise<ExternalCorkdiffCredentialRefreshResult> {
    const session = this.sessions.get(threadId);
    if (session === undefined) return "closed";
    const client = await this.findClient(session.className);
    if (client === null) {
      this.deleteSessionIfCurrent(threadId, session.generation);
      return "closed";
    }
    let updateResult: CommandResult;
    try {
      updateResult = await this.run("nvim", [
        "--server",
        session.nvimServerAddress,
        "--remote-expr",
        buildCorkdiffConnectionUpdateExpression(connection),
      ]);
    } catch (error) {
      if ((await this.findClient(session.className)) === null) {
        this.deleteSessionIfCurrent(threadId, session.generation);
        return "closed";
      }
      this.updateSessionIfCurrent(threadId, session.generation, (current) => ({
        ...current,
        credentialRefreshFailed: true,
      }));
      throw error;
    }
    if (updateResult.code !== 0) {
      if ((await this.findClient(session.className)) === null) {
        this.deleteSessionIfCurrent(threadId, session.generation);
        return "closed";
      }
      this.updateSessionIfCurrent(threadId, session.generation, (current) => ({
        ...current,
        credentialRefreshFailed: true,
      }));
      throw new Error(updateResult.stderr.trim() || "Failed to refresh Corkdiff credentials.");
    }
    this.updateSessionIfCurrent(threadId, session.generation, (current) => ({
      ...current,
      workspaceId: client.workspaceId,
      credentialRefreshFailed: false,
    }));
    return "refreshed";
  }

  private async launchFresh(
    input: ExternalCorkdiffOpenInput,
    connection: ExternalCorkdiffConnection,
  ): Promise<ExternalCorkdiffOpenResult> {
    const className = createCorkdiffGhosttyClassName(input.threadId);
    const nvimServerAddress = createCorkdiffNvimServerAddress(input.threadId, this.runtimeEnv);
    const result = await this.run(
      "hyprnav",
      [
        "spawn",
        "--print-workspace-id",
        "rand",
        "--",
        "ghostty",
        ...buildCorkdiffGhosttyArgs({
          className,
          nvimServerAddress,
          threadId: input.threadId,
        }),
      ],
      {
        cwd: input.cwd,
        env: buildCorkdiffEnvironment(this.runtimeEnv, input, connection),
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
      generation: ++this.nextSessionGeneration,
      className,
      nvimServerAddress,
      workspaceId: client.workspaceId,
      credentialRefreshFailed: false,
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
  const httpClient = yield* HttpClient.HttpClient;
  const manager = new ExternalCorkdiffManager(runCommand, process.env);
  const refreshGenerationByThread = new Map<string, number>();

  const resolveConnection = Effect.fn("desktop.corkdiff.resolveConnection")(function* () {
    const primary = yield* pool.primary;
    const config = yield* primary.currentConfig;
    if (Option.isNone(config)) {
      return yield* new ExternalCorkdiffCommandError({
        operation: "connection",
        cause: new Error("Primary desktop backend is not configured."),
      });
    }
    const issueTicket = (bearerToken: string) =>
      issueRemoteWebSocketTicket({
        httpBaseUrl: config.value.httpBaseUrl.href,
        bearerToken,
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    const ticket = yield* issueCorkdiffWebSocketTicketWithBearerRetry({
      getBearerToken: auth.getBearerToken,
      invalidateBearerToken: auth.invalidateBearerToken,
      issueTicket,
      shouldInvalidateBearer: isEnvironmentAuthInvalidError,
    }).pipe(
      Effect.mapError(
        (cause) => new ExternalCorkdiffCommandError({ operation: "connection", cause }),
      ),
    );
    return {
      serverUrl: toWebSocketUrl(config.value.httpBaseUrl),
      token: ticket.ticket,
      expiresAtMs: ticket.expiresAt.epochMilliseconds,
    } satisfies ExternalCorkdiffConnection;
  });

  const scheduleCredentialRefresh = Effect.fn("desktop.corkdiff.scheduleCredentialRefresh")(
    function* (input: ExternalCorkdiffOpenInput, initialExpiresAtMs: number) {
      const generation = (refreshGenerationByThread.get(input.threadId) ?? 0) + 1;
      refreshGenerationByThread.set(input.threadId, generation);
      yield* runExternalCorkdiffCredentialRefreshLoop({
        initialExpiresAtMs,
        isCurrent: () => refreshGenerationByThread.get(input.threadId) === generation,
        resolveConnection,
        refresh: (connection) => manager.refreshCredential(input.threadId, connection),
      }).pipe(Effect.forkDetach);
    },
  );

  const openOrFocus = Effect.fn("desktop.corkdiff.openOrFocus")(function* (
    input: ExternalCorkdiffOpenInput,
  ) {
    const existing = yield* Effect.tryPromise({
      try: () => manager.focusExisting(input.threadId),
      catch: (cause) => new ExternalCorkdiffCommandError({ operation: "inspect", cause }),
    });
    if (existing !== null) return existing;

    const connection = yield* resolveConnection();
    const adopted = yield* Effect.tryPromise({
      try: () => manager.focusExisting(input.threadId, connection),
      catch: (cause) => new ExternalCorkdiffCommandError({ operation: "inspect", cause }),
    });
    if (adopted !== null) {
      yield* scheduleCredentialRefresh(input, connection.expiresAtMs);
      return adopted;
    }

    const result = yield* Effect.tryPromise({
      try: () => manager.launch(input, connection),
      catch: (cause) => new ExternalCorkdiffCommandError({ operation: "launch", cause }),
    });
    yield* scheduleCredentialRefresh(input, connection.expiresAtMs);
    return result;
  });

  return ExternalCorkdiff.of({ openOrFocus });
});

export const layer = Layer.effect(ExternalCorkdiff, make);
