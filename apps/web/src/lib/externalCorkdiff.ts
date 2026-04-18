import { scopeProjectRef } from "@t3tools/client-runtime";
import { type ScopedThreadRef } from "@t3tools/contracts";

import { toastManager } from "../components/ui/toast";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import { selectProjectByRef, selectThreadByRef, useStore } from "../store";

interface ExternalCorkdiffConnection {
  readonly serverUrl: string;
  readonly token: string | null;
}

async function issueDesktopWebSocketToken(_httpBaseUrl: string): Promise<string> {
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/auth/ws-token"), {
    credentials: "include",
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Failed to issue Corkdiff websocket token (${response.status}).`);
  }

  const payload = (await response.json()) as { token?: unknown };
  if (typeof payload.token !== "string" || payload.token.trim().length === 0) {
    throw new Error("Server returned an invalid Corkdiff websocket token.");
  }
  return payload.token;
}

export async function resolveExternalCorkdiffConnection(input: {
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string | null;
  readonly issueWebSocketToken?: (httpBaseUrl: string) => Promise<string>;
}): Promise<ExternalCorkdiffConnection> {
  const parsedUrl = new URL(input.wsBaseUrl);
  if (parsedUrl.searchParams.has("wsToken")) {
    parsedUrl.searchParams.delete("token");
    return {
      serverUrl: parsedUrl.toString(),
      token: null,
    };
  }

  if (input.httpBaseUrl) {
    const tokenIssuer = input.issueWebSocketToken ?? issueDesktopWebSocketToken;
    const issuedToken = await tokenIssuer(input.httpBaseUrl);
    if (issuedToken.trim().length === 0) {
      throw new Error("Server returned an invalid Corkdiff websocket token.");
    }
    parsedUrl.searchParams.delete("token");
    parsedUrl.searchParams.set("wsToken", issuedToken);
    return {
      serverUrl: parsedUrl.toString(),
      token: null,
    };
  }

  const legacyToken = parsedUrl.searchParams.get("token");
  parsedUrl.searchParams.delete("token");
  return {
    serverUrl: parsedUrl.toString(),
    token: legacyToken,
  };
}

async function buildLaunchInput(threadRef: ScopedThreadRef): Promise<{
  cwd: string;
  serverUrl: string;
  token: string | null;
  threadId: string;
}> {
  const state = useStore.getState();
  const thread = selectThreadByRef(state, threadRef);
  if (!thread) {
    throw new Error("Thread not found.");
  }

  const project = selectProjectByRef(
    state,
    scopeProjectRef(thread.environmentId, thread.projectId),
  );
  if (!project) {
    throw new Error("Thread project not found.");
  }

  const cwd = thread.worktreePath ?? project.cwd;
  if (!cwd || cwd.trim().length === 0) {
    throw new Error("Corkdiff launch requires a valid working directory.");
  }

  const bootstrap = window.desktopBridge?.getLocalEnvironmentBootstrap() ?? null;
  const bridgeWsUrl = bootstrap?.wsBaseUrl ?? null;
  if (!bridgeWsUrl) {
    throw new Error("Desktop websocket URL is unavailable.");
  }

  const connection = await resolveExternalCorkdiffConnection({
    wsBaseUrl: bridgeWsUrl,
    httpBaseUrl: bootstrap?.httpBaseUrl ?? null,
  });

  return {
    cwd,
    serverUrl: connection.serverUrl,
    token: connection.token,
    threadId: threadRef.threadId,
  };
}

export async function toggleExternalCorkdiffForThread(threadRef: ScopedThreadRef): Promise<void> {
  try {
    if (!window.desktopBridge?.toggleExternalCorkdiff) {
      throw new Error("External Corkdiff is only available in the desktop app.");
    }
    await window.desktopBridge.toggleExternalCorkdiff(await buildLaunchInput(threadRef));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to open external Corkdiff.";
    toastManager.add({
      type: "error",
      title: "Unable to open Corkdiff",
      description: message,
    });
  }
}
