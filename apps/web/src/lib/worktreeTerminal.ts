import { type ProjectId, type ThreadId } from "@t3tools/contracts";

import { toastManager } from "../components/ui/toast";
import {
  selectProjectsAcrossEnvironments,
  selectThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { useWorktreeTerminalPresenceStore } from "../worktreeTerminalPresenceStore";

function buildLaunchInput(threadId: ThreadId): {
  cwd: string;
} {
  const state = useStore.getState();
  const thread = selectThreadsAcrossEnvironments(state).find(
    (candidate) => candidate.id === threadId,
  );
  if (!thread) {
    throw new Error("Thread not found.");
  }

  const project = selectProjectsAcrossEnvironments(state).find(
    (candidate) =>
      candidate.id === thread.projectId && candidate.environmentId === thread.environmentId,
  );
  if (!project) {
    throw new Error("Thread project not found.");
  }

  const cwd = thread.worktreePath ?? project.cwd;
  if (!cwd || cwd.trim().length === 0) {
    throw new Error("Worktree terminal launch requires a valid working directory.");
  }

  return {
    cwd,
  };
}

export function resolveWorktreeTerminalCwd(input: {
  readonly projectId: ProjectId;
  readonly worktreePath?: string | null;
}): string {
  const state = useStore.getState();
  const project = selectProjectsAcrossEnvironments(state).find(
    (candidate) => candidate.id === input.projectId,
  );
  if (!project) {
    throw new Error("Project not found.");
  }

  const cwd = input.worktreePath ?? project.cwd;
  if (!cwd || cwd.trim().length === 0) {
    throw new Error("Worktree terminal launch requires a valid working directory.");
  }

  return cwd;
}

export async function openWorktreeTerminalForThread(threadId: ThreadId): Promise<void> {
  try {
    if (!window.desktopBridge?.openWorktreeTerminal) {
      throw new Error("Worktree terminal is only available in the desktop app.");
    }
    const result = await window.desktopBridge.openWorktreeTerminal(buildLaunchInput(threadId));
    useWorktreeTerminalPresenceStore.getState().markOpen(result.worktreePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to open worktree terminal.";
    toastManager.add({
      type: "error",
      title: "Unable to open worktree terminal",
      description: message,
    });
  }
}

export async function openWorktreeTerminalForProject(input: {
  readonly projectId: ProjectId;
  readonly worktreePath?: string | null;
}): Promise<void> {
  try {
    if (!window.desktopBridge?.openWorktreeTerminal) {
      throw new Error("Worktree terminal is only available in the desktop app.");
    }
    const result = await window.desktopBridge.openWorktreeTerminal({
      cwd: resolveWorktreeTerminalCwd(input),
    });
    useWorktreeTerminalPresenceStore.getState().markOpen(result.worktreePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to open worktree terminal.";
    toastManager.add({
      type: "error",
      title: "Unable to open worktree terminal",
      description: message,
    });
  }
}
