import {
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../store";

import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  buildExpiredTerminalContextToastCopy,
  buildTemporaryWorktreeBranchName,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  hasForkableThreadHistory,
  hasServerAcknowledgedLocalDispatch,
  reconcileMountedTerminalThreadIds,
  isThreadForkReady,
  waitForStartedServerThread,
  threadSupportsCodexFork,
  resolvePendingWorktreeAction,
} from "./ChatView.logic";

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats clear empty-state guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
  });

  it("formats omission guidance for sent messages", () => {
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps previously mounted open threads and adds the active open thread", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [
          ThreadId.makeUnsafe("thread-hidden"),
          ThreadId.makeUnsafe("thread-stale"),
        ],
        openThreadIds: [ThreadId.makeUnsafe("thread-hidden"), ThreadId.makeUnsafe("thread-active")],
        activeThreadId: ThreadId.makeUnsafe("thread-active"),
        activeThreadTerminalOpen: true,
      }),
    ).toEqual([ThreadId.makeUnsafe("thread-hidden"), ThreadId.makeUnsafe("thread-active")]);
  });

  it("drops mounted threads once their terminal drawer is no longer open", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [ThreadId.makeUnsafe("thread-closed")],
        openThreadIds: [],
        activeThreadId: ThreadId.makeUnsafe("thread-closed"),
        activeThreadTerminalOpen: false,
      }),
    ).toEqual([]);
  });

  it("keeps only the most recently active hidden terminal threads", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [
          ThreadId.makeUnsafe("thread-1"),
          ThreadId.makeUnsafe("thread-2"),
          ThreadId.makeUnsafe("thread-3"),
        ],
        openThreadIds: [
          ThreadId.makeUnsafe("thread-1"),
          ThreadId.makeUnsafe("thread-2"),
          ThreadId.makeUnsafe("thread-3"),
          ThreadId.makeUnsafe("thread-4"),
        ],
        activeThreadId: ThreadId.makeUnsafe("thread-4"),
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual([
      ThreadId.makeUnsafe("thread-2"),
      ThreadId.makeUnsafe("thread-3"),
      ThreadId.makeUnsafe("thread-4"),
    ]);
  });

  it("moves the active thread to the end so it is treated as most recently used", () => {
    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds: [
          ThreadId.makeUnsafe("thread-a"),
          ThreadId.makeUnsafe("thread-b"),
          ThreadId.makeUnsafe("thread-c"),
        ],
        openThreadIds: [
          ThreadId.makeUnsafe("thread-a"),
          ThreadId.makeUnsafe("thread-b"),
          ThreadId.makeUnsafe("thread-c"),
        ],
        activeThreadId: ThreadId.makeUnsafe("thread-a"),
        activeThreadTerminalOpen: true,
        maxHiddenThreadCount: 2,
      }),
    ).toEqual([
      ThreadId.makeUnsafe("thread-b"),
      ThreadId.makeUnsafe("thread-c"),
      ThreadId.makeUnsafe("thread-a"),
    ]);
  });

  it("defaults to the hidden mounted terminal cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => ThreadId.makeUnsafe(`thread-${index + 1}`),
    );

    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadTerminalOpen: false,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_TERMINAL_THREADS));
  });
});

const makeThread = (input?: {
  id?: ThreadId;
  latestTurn?: {
    turnId: TurnId;
    state: "running" | "completed";
    requestedAt: string;
    startedAt: string | null;
    completedAt: string | null;
  } | null;
}) => ({
  id: input?.id ?? ThreadId.makeUnsafe("thread-1"),
  codexThreadId: null,
  projectId: ProjectId.makeUnsafe("project-1"),
  title: "Thread",
  modelSelection: { provider: "codex" as const, model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  session: null,
  messages: [],
  proposedPlans: [],
  error: null,
  createdAt: "2026-03-29T00:00:00.000Z",
  archivedAt: null,
  updatedAt: "2026-03-29T00:00:00.000Z",
  latestTurn: input?.latestTurn
    ? {
        ...input.latestTurn,
        assistantMessageId: null,
      }
    : null,
  branch: null,
  worktreePath: null,
  turnDiffSummaries: [],
  activities: [],
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  useStore.setState((state) => ({
    ...state,
    projects: [],
    threads: [],
    bootstrapComplete: true,
  }));
});

describe("waitForStartedServerThread", () => {
  it("resolves immediately when the thread is already started", async () => {
    const threadId = ThreadId.makeUnsafe("thread-started");
    useStore.setState((state) => ({
      ...state,
      threads: [
        makeThread({
          id: threadId,
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-started"),
            state: "running",
            requestedAt: "2026-03-29T00:00:01.000Z",
            startedAt: "2026-03-29T00:00:01.000Z",
            completedAt: null,
          },
        }),
      ],
    }));

    await expect(waitForStartedServerThread(threadId)).resolves.toBe(true);
  });

  it("waits for the thread to start via subscription updates", async () => {
    const threadId = ThreadId.makeUnsafe("thread-wait");
    useStore.setState((state) => ({
      ...state,
      threads: [makeThread({ id: threadId })],
    }));

    const promise = waitForStartedServerThread(threadId, 500);

    useStore.setState((state) => ({
      ...state,
      threads: [
        makeThread({
          id: threadId,
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-started"),
            state: "running",
            requestedAt: "2026-03-29T00:00:01.000Z",
            startedAt: "2026-03-29T00:00:01.000Z",
            completedAt: null,
          },
        }),
      ],
    }));

    await expect(promise).resolves.toBe(true);
  });

  it("handles the thread starting between the initial read and subscription setup", async () => {
    const threadId = ThreadId.makeUnsafe("thread-race");
    useStore.setState((state) => ({
      ...state,
      threads: [makeThread({ id: threadId })],
    }));

    const originalSubscribe = useStore.subscribe.bind(useStore);
    let raced = false;
    vi.spyOn(useStore, "subscribe").mockImplementation((listener) => {
      if (!raced) {
        raced = true;
        useStore.setState((state) => ({
          ...state,
          threads: [
            makeThread({
              id: threadId,
              latestTurn: {
                turnId: TurnId.makeUnsafe("turn-race"),
                state: "running",
                requestedAt: "2026-03-29T00:00:01.000Z",
                startedAt: "2026-03-29T00:00:01.000Z",
                completedAt: null,
              },
            }),
          ],
        }));
      }
      return originalSubscribe(listener);
    });

    await expect(waitForStartedServerThread(threadId, 500)).resolves.toBe(true);
  });

  it("returns false after the timeout when the thread never starts", async () => {
    vi.useFakeTimers();

    const threadId = ThreadId.makeUnsafe("thread-timeout");
    useStore.setState((state) => ({
      ...state,
      threads: [makeThread({ id: threadId })],
    }));
    const promise = waitForStartedServerThread(threadId, 500);

    await vi.advanceTimersByTimeAsync(500);

    await expect(promise).resolves.toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  const projectId = ProjectId.makeUnsafe("project-1");
  const previousLatestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    state: "completed" as const,
    requestedAt: "2026-03-29T00:00:00.000Z",
    startedAt: "2026-03-29T00:00:01.000Z",
    completedAt: "2026-03-29T00:00:10.000Z",
    assistantMessageId: null,
  };

  const previousSession = {
    provider: "codex" as const,
    status: "ready" as const,
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:10.000Z",
    orchestrationStatus: "idle" as const,
  };

  it("does not clear local dispatch before server state changes", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.makeUnsafe("thread-1"),
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: previousLatestTurn,
        session: previousSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("clears local dispatch when a new turn is already settled", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.makeUnsafe("thread-1"),
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: {
          ...previousLatestTurn,
          turnId: TurnId.makeUnsafe("turn-2"),
          requestedAt: "2026-03-29T00:01:00.000Z",
          startedAt: "2026-03-29T00:01:01.000Z",
          completedAt: "2026-03-29T00:01:30.000Z",
        },
        session: {
          ...previousSession,
          updatedAt: "2026-03-29T00:01:30.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("clears local dispatch when the session changes without an observed running phase", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.makeUnsafe("thread-1"),
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: previousLatestTurn,
        session: {
          ...previousSession,
          updatedAt: "2026-03-29T00:00:11.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });
});

describe("pending worktree resolution", () => {
  it("creates a named worktree branch from the selected base branch", () => {
    expect(
      resolvePendingWorktreeAction({
        baseBranch: "feature/base",
        pendingWorktreeBranch: "feature/new-worktree",
        gitBranches: [
          {
            name: "feature/base",
            current: false,
            isDefault: false,
            worktreePath: null,
          },
        ],
      }),
    ).toEqual({
      kind: "create-worktree",
      branch: "feature/base",
      newBranch: "feature/new-worktree",
    });
  });

  it("falls back to the current repo branch when no explicit base branch is set", () => {
    expect(
      resolvePendingWorktreeAction({
        baseBranch: null,
        pendingWorktreeBranch: "feature/new-worktree",
        gitBranches: [
          {
            name: "main",
            current: true,
            isDefault: true,
            worktreePath: null,
          },
        ],
      }),
    ).toEqual({
      kind: "create-worktree",
      branch: "main",
      newBranch: "feature/new-worktree",
    });
  });

  it("fails clearly when the named target already exists locally", () => {
    expect(
      resolvePendingWorktreeAction({
        baseBranch: "main",
        pendingWorktreeBranch: "feature/new-worktree",
        gitBranches: [
          {
            name: "feature/new-worktree",
            current: false,
            isDefault: false,
            worktreePath: null,
          },
        ],
      }),
    ).toEqual({
      kind: "error",
      message:
        'Branch "feature/new-worktree" already exists locally. Pick a different worktree branch name or use that branch directly.',
    });
  });

  it("fails clearly when the named target exists remotely", () => {
    expect(
      resolvePendingWorktreeAction({
        baseBranch: "main",
        pendingWorktreeBranch: "origin/feature/remote-only",
        gitBranches: [
          {
            name: "origin/feature/remote-only",
            current: false,
            isDefault: false,
            worktreePath: null,
            isRemote: true,
            remoteName: "origin",
          },
        ],
      }),
    ).toEqual({
      kind: "error",
      message:
        'Branch "origin/feature/remote-only" already exists on a remote. Pick a different worktree branch name or create/check out the branch first.',
    });
  });

  it("uses the legacy autogenerated branch path when no named worktree target is set", () => {
    const result = resolvePendingWorktreeAction({
      baseBranch: "main",
      pendingWorktreeBranch: null,
      gitBranches: [
        {
          name: "main",
          current: true,
          isDefault: true,
          worktreePath: null,
        },
      ],
    });

    expect(result.kind).toBe("create-worktree");
    if (result.kind !== "create-worktree") {
      throw new Error("Expected create-worktree action");
    }
    expect(result.branch).toBe("main");
    expect(result.newBranch).toMatch(/^t3code\/[0-9a-f]{8}$/);
  });

  it("builds temporary worktree branch names with the expected prefix", () => {
    expect(buildTemporaryWorktreeBranchName()).toMatch(/^t3code\/[0-9a-f]{8}$/);
  });
});

describe("fork readiness", () => {
  const settledLatestTurn: OrchestrationLatestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    state: "completed",
    requestedAt: "2026-03-17T12:52:29.000Z",
    startedAt: "2026-03-17T12:52:30.000Z",
    completedAt: "2026-03-17T12:52:31.000Z",
    assistantMessageId: null,
  };

  it("counts reply-only server history as forkable even without checkpoints", () => {
    expect(
      hasForkableThreadHistory({
        messages: [
          {
            id: MessageId.makeUnsafe("msg-user-1"),
            role: "user",
            text: "testing",
            streaming: false,
            createdAt: "2026-03-17T12:52:29.000Z",
          },
          {
            id: MessageId.makeUnsafe("msg-assistant-1"),
            role: "assistant",
            text: "Received. I'm ready in /tmp/repo.",
            streaming: false,
            createdAt: "2026-03-17T12:52:30.000Z",
          },
        ],
        activities: [],
        proposedPlans: [],
        turnDiffSummaries: [],
        latestTurn: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
        session: null,
      }),
    ).toBe(true);
  });

  it("treats settled history without checkpoints as fork-ready", () => {
    expect(
      isThreadForkReady({
        thread: {
          messages: [
            {
              id: MessageId.makeUnsafe("msg-user-1"),
              role: "user",
              text: "testing",
              streaming: false,
              createdAt: "2026-03-17T12:52:29.000Z",
            },
            {
              id: MessageId.makeUnsafe("msg-assistant-1"),
              role: "assistant",
              text: "Received. I'm ready in /tmp/repo.",
              streaming: false,
              createdAt: "2026-03-17T12:52:30.000Z",
            },
          ],
          activities: [],
          proposedPlans: [],
          turnDiffSummaries: [],
          latestTurn: settledLatestTurn,
          modelSelection: {
            provider: "codex",
            model: "gpt-5.4",
          },
          session: {
            provider: "codex",
            status: "ready",
            createdAt: "2026-03-17T12:52:29.000Z",
            updatedAt: "2026-03-17T12:52:31.000Z",
            orchestrationStatus: "ready",
          },
        },
        isServerThread: true,
        phase: "ready",
        isSendBusy: false,
        isConnecting: false,
        isRevertingCheckpoint: false,
      }),
    ).toBe(true);
  });

  it("blocks forking while a latest turn is still in flight", () => {
    expect(
      isThreadForkReady({
        thread: {
          messages: [
            {
              id: MessageId.makeUnsafe("msg-user-1"),
              role: "user",
              text: "testing",
              streaming: false,
              createdAt: "2026-03-17T12:52:29.000Z",
            },
          ],
          activities: [],
          proposedPlans: [],
          turnDiffSummaries: [],
          latestTurn: {
            ...settledLatestTurn,
            state: "running",
            completedAt: null,
          },
          modelSelection: {
            provider: "codex",
            model: "gpt-5.4",
          },
          session: {
            provider: "codex",
            status: "running",
            createdAt: "2026-03-17T12:52:29.000Z",
            updatedAt: "2026-03-17T12:52:31.000Z",
            orchestrationStatus: "running",
          },
        },
        isServerThread: true,
        phase: "running",
        isSendBusy: false,
        isConnecting: false,
        isRevertingCheckpoint: false,
      }),
    ).toBe(false);
  });

  it("only allows true fork support for codex-backed threads", () => {
    expect(
      threadSupportsCodexFork({
        messages: [],
        activities: [],
        proposedPlans: [],
        turnDiffSummaries: [],
        latestTurn: null,
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
        session: null,
      }),
    ).toBe(true);

    expect(
      threadSupportsCodexFork({
        messages: [],
        activities: [],
        proposedPlans: [],
        turnDiffSummaries: [],
        latestTurn: null,
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-sonnet-4-5",
        },
        session: {
          provider: "claudeAgent",
          status: "ready",
          createdAt: "2026-03-17T12:52:29.000Z",
          updatedAt: "2026-03-17T12:52:31.000Z",
          orchestrationStatus: "ready",
        },
      }),
    ).toBe(false);
  });
});
