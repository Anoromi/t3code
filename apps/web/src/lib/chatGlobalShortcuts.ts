import { type ProjectId } from "@t3tools/contracts";

export type ChatGlobalShortcutCommand =
  | "chat.new"
  | "chat.newLocal"
  | "navigation.commandMenu"
  | "terminal.worktree.open";

export interface ChatGlobalShortcutThreadContext {
  readonly projectId: ProjectId;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly envMode?: "local" | "worktree" | null;
}

export type ChatGlobalShortcutAction =
  | { readonly type: "navigation.commandMenu" }
  | { readonly type: "chat.newLocal"; readonly projectId: ProjectId }
  | {
      readonly type: "chat.new";
      readonly projectId: ProjectId;
      readonly branch: string | null;
      readonly worktreePath: string | null;
      readonly envMode: "local" | "worktree";
    }
  | {
      readonly type: "terminal.worktree.open";
      readonly projectId: ProjectId;
      readonly worktreePath: string | null;
    };

function resolveProjectId(input: {
  readonly activeThread: ChatGlobalShortcutThreadContext | null;
  readonly activeDraftThread: ChatGlobalShortcutThreadContext | null;
  readonly defaultProjectId: ProjectId | null;
}): ProjectId | null {
  return (
    input.activeThread?.projectId ?? input.activeDraftThread?.projectId ?? input.defaultProjectId
  );
}

export function resolveChatGlobalShortcutAction(input: {
  readonly command: ChatGlobalShortcutCommand | null;
  readonly activeThread: ChatGlobalShortcutThreadContext | null;
  readonly activeDraftThread: ChatGlobalShortcutThreadContext | null;
  readonly defaultProjectId: ProjectId | null;
}): ChatGlobalShortcutAction | null {
  if (input.command === "navigation.commandMenu") {
    return { type: "navigation.commandMenu" };
  }

  const projectId = resolveProjectId(input);
  if (!projectId) {
    return null;
  }

  if (input.command === "chat.newLocal") {
    return {
      type: "chat.newLocal",
      projectId,
    };
  }

  if (input.command === "chat.new") {
    return {
      type: "chat.new",
      projectId,
      branch: input.activeThread?.branch ?? input.activeDraftThread?.branch ?? null,
      worktreePath:
        input.activeThread?.worktreePath ?? input.activeDraftThread?.worktreePath ?? null,
      envMode:
        input.activeDraftThread?.envMode ??
        (input.activeThread?.worktreePath ? "worktree" : "local"),
    };
  }

  if (input.command === "terminal.worktree.open") {
    return {
      type: "terminal.worktree.open",
      projectId,
      worktreePath:
        input.activeThread?.worktreePath ?? input.activeDraftThread?.worktreePath ?? null,
    };
  }

  return null;
}
