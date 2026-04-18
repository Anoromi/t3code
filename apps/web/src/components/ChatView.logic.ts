import {
  type KeybindingCommand,
  type EnvironmentId,
  type GitBranch,
  type ResolvedKeybindingsConfig,
  ProjectId,
  type ModelSelection,
  type OrchestrationLatestTurn,
  type ProviderKind,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import { type ChatMessage, type SessionPhase, type Thread, type ThreadSession } from "../types";
import { type ComposerImageAttachment, type DraftThreadState } from "../composerDraftStore";
import { Schema } from "effect";
import { selectThreadByRef, useStore } from "../store";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import type { DraftThreadEnvMode } from "../composerDraftStore";
import { resolveShortcutCommand, type ShortcutEventLike } from "../keybindings";

export { buildTemporaryWorktreeBranchName };

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";
export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
  error: string | null,
): Thread {
  return {
    id: threadId,
    environmentId: draftThread.environmentId,
    codexThreadId: null,
    projectId: draftThread.projectId,
    title: "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    error,
    createdAt: draftThread.createdAt,
    archivedAt: null,
    updatedAt: draftThread.createdAt,
    latestTurn: null,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    forkOrigin: null,
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
  };
}

export function shouldWriteThreadErrorToCurrentServerThread(input: {
  serverThread:
    | {
        environmentId: EnvironmentId;
        id: ThreadId;
      }
    | null
    | undefined;
  routeThreadRef: ScopedThreadRef;
  targetThreadId: ThreadId;
}): boolean {
  return Boolean(
    input.serverThread &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    input.serverThread.environmentId === input.routeThreadRef.environmentId &&
    input.serverThread.id === input.targetThreadId,
  );
}

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): string[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) => threadId !== input.activeThreadId && openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(
    0,
    input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  );
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadTerminalOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export function resolveChatViewShortcutCommand(input: {
  event: ShortcutEventLike;
  keybindings: ResolvedKeybindingsConfig;
  terminalFocus: boolean;
  terminalOpen: boolean;
  preferExternalDiff: boolean;
}): KeybindingCommand | null {
  if (input.preferExternalDiff) {
    const desktopDiffCommand = resolveShortcutCommand(input.event, input.keybindings, {
      context: {
        terminalFocus: false,
        terminalOpen: input.terminalOpen,
      },
    });
    if (desktopDiffCommand === "diff.toggle") {
      return desktopDiffCommand;
    }
  }

  return resolveShortcutCommand(input.event, input.keybindings, {
    context: {
      terminalFocus: input.terminalFocus,
      terminalOpen: input.terminalOpen,
    },
  });
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

type ForkableThread = Pick<
  Thread,
  | "messages"
  | "activities"
  | "proposedPlans"
  | "turnDiffSummaries"
  | "latestTurn"
  | "session"
  | "modelSelection"
>;

export function threadSupportsCodexFork(thread: ForkableThread | null): boolean {
  if (thread === null) {
    return false;
  }
  return (thread.session?.provider ?? thread.modelSelection.provider) === "codex";
}

export function hasForkableThreadHistory(thread: ForkableThread | null): boolean {
  if (thread === null) {
    return false;
  }
  return (
    thread.messages.length > 0 ||
    thread.activities.length > 0 ||
    thread.proposedPlans.length > 0 ||
    thread.turnDiffSummaries.length > 0 ||
    thread.latestTurn !== null
  );
}

export function latestTurnIsForkSettled(latestTurn: OrchestrationLatestTurn | null): boolean {
  if (latestTurn === null) {
    return true;
  }
  if (latestTurn.state === "running") {
    return false;
  }
  if (latestTurn.startedAt !== null && latestTurn.completedAt === null) {
    return false;
  }
  return true;
}

export function isThreadForkReady(options: {
  thread: ForkableThread | null;
  isServerThread: boolean;
  phase: SessionPhase | null;
  isSendBusy: boolean;
  isConnecting: boolean;
  isRevertingCheckpoint: boolean;
}): boolean {
  if (!options.isServerThread || !hasForkableThreadHistory(options.thread)) {
    return false;
  }
  if (
    options.phase === "running" ||
    options.isSendBusy ||
    options.isConnecting ||
    options.isRevertingCheckpoint
  ) {
    return false;
  }
  if (!latestTurnIsForkSettled(options.thread?.latestTurn ?? null)) {
    return false;
  }
  return options.thread?.session?.orchestrationStatus !== "running";
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

export function resolveSendEnvMode(input: {
  requestedEnvMode: DraftThreadEnvMode;
  isGitRepo: boolean;
}): DraftThreadEnvMode {
  return input.isGitRepo ? input.requestedEnvMode : "local";
}

export type PendingWorktreeAction =
  | {
      kind: "create-worktree";
      branch: string;
      newBranch: string;
    }
  | {
      kind: "error";
      message: string;
    };

function normalizeBranchName(branch: string | null | undefined): string | null {
  const normalized = branch?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function findCurrentLocalBranch(gitBranches: ReadonlyArray<GitBranch>): string | null {
  return gitBranches.find((branch) => !branch.isRemote && branch.current)?.name ?? null;
}

export function resolvePendingWorktreeAction(input: {
  baseBranch: string | null;
  pendingWorktreeBranch: string | null;
  gitBranches: ReadonlyArray<GitBranch>;
}): PendingWorktreeAction {
  const baseBranch =
    normalizeBranchName(input.baseBranch) ??
    normalizeBranchName(findCurrentLocalBranch(input.gitBranches));
  if (baseBranch === null) {
    return {
      kind: "error",
      message: "Select a base branch before sending in New worktree mode.",
    };
  }

  const pendingWorktreeBranch = normalizeBranchName(input.pendingWorktreeBranch);
  if (pendingWorktreeBranch !== null) {
    const localBranch = input.gitBranches.find(
      (branch) => !branch.isRemote && branch.name === pendingWorktreeBranch,
    );
    if (localBranch) {
      return {
        kind: "error",
        message: `Branch "${pendingWorktreeBranch}" already exists locally. Pick a different worktree branch name or use that branch directly.`,
      };
    }

    const remoteBranch = input.gitBranches.find(
      (branch) => branch.isRemote && branch.name === pendingWorktreeBranch,
    );
    if (remoteBranch) {
      return {
        kind: "error",
        message: `Branch "${pendingWorktreeBranch}" already exists on a remote. Pick a different worktree branch name or create/check out the branch first.`,
      };
    }

    return {
      kind: "create-worktree",
      branch: baseBranch,
      newBranch: pendingWorktreeBranch,
    };
  }

  return {
    kind: "create-worktree",
    branch: baseBranch,
    newBranch: buildTemporaryWorktreeBranchName(),
  };
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 || options.imageCount > 0 || sendableTerminalContexts.length > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

export function deriveLockedProvider(input: {
  thread: Thread | null | undefined;
  selectedProvider: ProviderKind | null;
  threadProvider: ProviderKind | null;
}): ProviderKind | null {
  if (!threadHasStarted(input.thread)) {
    return null;
  }
  return input.thread?.session?.provider ?? input.threadProvider ?? input.selectedProvider ?? null;
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const getThread = () => selectThreadByRef(useStore.getState(), threadRef);
  const thread = getThread();

  if (threadHasStarted(thread)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = useStore.subscribe((state) => {
      if (!threadHasStarted(selectThreadByRef(state, threadRef))) {
        return;
      }
      finish(true);
    });

    if (threadHasStarted(getThread())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionOrchestrationStatus: ThreadSession["orchestrationStatus"] | null;
  sessionUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: { preparingWorktree?: boolean },
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionOrchestrationStatus: session?.orchestrationStatus ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  session: Thread["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;
  const latestTurnChanged =
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null);

  if (input.phase === "running") {
    if (!latestTurnChanged) {
      return false;
    }
    if (latestTurn?.startedAt === null || latestTurn === null) {
      return false;
    }
    if (
      session?.activeTurnId !== undefined &&
      session.activeTurnId !== null &&
      latestTurn?.turnId !== session.activeTurnId
    ) {
      return false;
    }
    return true;
  }

  return (
    latestTurnChanged ||
    input.localDispatch.sessionOrchestrationStatus !== (session?.orchestrationStatus ?? null) ||
    input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}
