import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import type {
  DesktopBridge,
  DesktopHyprnavSyncInput,
  DesktopHyprnavSyncResult,
  EditorId,
  ProjectHyprnavSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { PrimaryEnvironmentHttpClient } from "./environments/primary/httpClient";
import { runPrimaryHttp } from "./lib/runtime";

export const HYPRNAV_SYNC_RETRY_DELAYS_MS = [250, 1_000] as const;
export const HYPRNAV_CREDENTIAL_REFRESH_DELAY_MS = 4 * 60_000;

export function hyprnavCredentialRefreshDelay(settings: ProjectHyprnavSettings): number | null {
  return settings.bindings.some(
    (binding) =>
      binding.action === "shell-command" &&
      (binding.command.includes("{corkdiffLaunchCommand}") ||
        binding.command.includes("{corkdiffServerUrl}") ||
        binding.command.includes("{corkdiffToken}")),
  )
    ? HYPRNAV_CREDENTIAL_REFRESH_DELAY_MS
    : null;
}

export function waitForHyprnavRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export function createCancelableHyprnavDelay(): {
  readonly wait: (delayMs: number) => Promise<void>;
  readonly cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    wake?.();
    wake = null;
  };
  return {
    wait: (delayMs) => {
      cancel();
      return new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(() => {
          timer = null;
          wake = null;
          resolve();
        }, delayMs);
      });
    },
    cancel,
  };
}

export async function syncHyprnavWithRetry(input: {
  readonly sync: NonNullable<DesktopBridge["syncHyprnavEnvironment"]>;
  readonly request: DesktopHyprnavSyncInput;
  readonly retryDelaysMs?: readonly number[];
  readonly wait?: (delayMs: number) => Promise<void>;
}): Promise<DesktopHyprnavSyncResult> {
  const retryDelays = input.retryDelaysMs ?? HYPRNAV_SYNC_RETRY_DELAYS_MS;
  const wait = input.wait ?? waitForHyprnavRetry;
  let result = await input.sync(input.request);
  for (const delayMs of retryDelays) {
    if (result.status === "ok") return result;
    await wait(delayMs);
    result = await input.sync(input.request);
  }
  return result;
}

export function getPrimaryDesktopBootstrap() {
  return (
    window.desktopBridge
      ?.getLocalEnvironmentBootstraps()
      .find((bootstrap) => bootstrap.id === PRIMARY_LOCAL_ENVIRONMENT_ID) ?? null
  );
}

export function attachHyprnavWebSocketTicket(wsBaseUrl: string, ticket: string): string {
  const url = new URL(wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  url.searchParams.delete("token");
  url.searchParams.delete("wsToken");
  url.searchParams.set("wsTicket", ticket);
  return url.toString();
}

export async function resolveHyprnavCorkdiffConnection(): Promise<{
  readonly serverUrl: string;
  readonly token: null;
}> {
  const bootstrap = getPrimaryDesktopBootstrap();
  if (!bootstrap?.wsBaseUrl) {
    throw new Error("Desktop websocket URL is unavailable.");
  }

  const issued = await runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) => client.auth.webSocketTicket({ headers: {} })),
    ),
  );
  return {
    serverUrl: attachHyprnavWebSocketTicket(bootstrap.wsBaseUrl, issued.ticket),
    token: null,
  };
}

export function preferredEditorForHyprnav(
  settings: readonly DesktopHyprnavSyncInput[],
  availableEditors: readonly EditorId[],
  resolvePreferredEditor: (available: readonly EditorId[]) => EditorId | null,
): EditorId | null {
  const needsEditor = settings.some((request) =>
    request.hyprnav.bindings.some((binding) => binding.action === "open-favorite-editor"),
  );
  return needsEditor ? resolvePreferredEditor(availableEditors) : null;
}

export async function publishHyprnavRequests(input: {
  readonly requests: readonly DesktopHyprnavSyncInput[];
  readonly availableEditors: readonly EditorId[];
  readonly resolvePreferredEditor: (available: readonly EditorId[]) => EditorId | null;
  readonly resolveCorkdiffConnection?: typeof resolveHyprnavCorkdiffConnection;
}): Promise<DesktopHyprnavSyncResult> {
  const sync = window.desktopBridge?.syncHyprnavEnvironment;
  if (typeof sync !== "function") {
    return {
      status: "unavailable",
      message: "The Hyprnav desktop runtime is unavailable.",
    };
  }

  const preferredEditor = preferredEditorForHyprnav(
    input.requests,
    input.availableEditors,
    input.resolvePreferredEditor,
  );
  const needsCorkdiff = input.requests.some(
    (request) =>
      request.threadId !== null &&
      request.threadId !== undefined &&
      request.hyprnav.bindings.some(
        (binding) =>
          binding.action === "shell-command" &&
          (binding.command.includes("{corkdiffLaunchCommand}") ||
            binding.command.includes("{corkdiffServerUrl}") ||
            binding.command.includes("{corkdiffToken}")),
      ),
  );
  const corkdiffConnection = needsCorkdiff
    ? await (input.resolveCorkdiffConnection ?? resolveHyprnavCorkdiffConnection)()
    : null;

  for (const request of input.requests) {
    const result = await syncHyprnavWithRetry({
      sync,
      request: {
        ...request,
        preferredEditor,
        corkdiffConnection,
      },
    });
    if (result.status !== "ok") return result;
  }
  return { status: "ok", message: null };
}
