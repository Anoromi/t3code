import { type ThreadId } from "@t3tools/contracts";

import { toastManager } from "../components/ui/toast";
import { selectProjectById, selectThreadById, useStore } from "../store";

function buildLaunchInput(threadId: ThreadId): {
  cwd: string;
  serverUrl: string;
  token: string | null;
  threadId: string;
} {
  const state = useStore.getState();
  const thread = selectThreadById(threadId)(state);
  if (!thread) {
    throw new Error("Thread not found.");
  }

  const project = selectProjectById(thread.projectId)(state);
  if (!project) {
    throw new Error("Thread project not found.");
  }

  const cwd = thread.worktreePath ?? project.cwd;
  if (!cwd || cwd.trim().length === 0) {
    throw new Error("Corkdiff launch requires a valid working directory.");
  }

  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  if (!bridgeWsUrl) {
    throw new Error("Desktop websocket URL is unavailable.");
  }

  const parsedUrl = new URL(bridgeWsUrl);
  const token = parsedUrl.searchParams.get("token");
  parsedUrl.searchParams.delete("token");

  return {
    cwd,
    serverUrl: parsedUrl.toString(),
    token,
    threadId,
  };
}

export async function toggleExternalCorkdiffForThread(threadId: ThreadId): Promise<void> {
  try {
    if (!window.desktopBridge?.toggleExternalCorkdiff) {
      throw new Error("External Corkdiff is only available in the desktop app.");
    }
    await window.desktopBridge.toggleExternalCorkdiff(buildLaunchInput(threadId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to open external Corkdiff.";
    toastManager.add({
      type: "error",
      title: "Unable to open Corkdiff",
      description: message,
    });
  }
}
